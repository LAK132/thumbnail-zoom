/**
 * Copyright (c) 2011-2012 David M. Adler
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of copyright holders nor the names of its
 *    contributors may be used to endorse or promote products derived
 *    from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED
 * TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
 * PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL COPYRIGHT HOLDERS OR CONTRIBUTORS
 * BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

/*
 * pagesIndirect.js: this module defines utility routines for the
 * rule Pages.OthersIndirect.  This module contains only functionality
 * which is generic to all sites; site-specific rules are in pages.js.
 */
 
"use strict";

var EXPORTED_SYMBOLS = [];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://thumbnailzoomplus/common.js");

/**
 * Pages namespace
 */
ThumbnailZoomPlus.PagesIndirect = {
  /* Logger for this object. */
  _logger : null,

  /**
   * Initializes the resource.
   */
  _init : function() {
    this._logger = ThumbnailZoomPlus.getLogger("ThumbnailZoomPlus.PagesIndirect");
    this._logger.trace("_init");
  },
  
  // parseHtmlDoc parses the specified html string and returns
  // a result object with result.doc and result.body set.
  parseHtmlDoc : function(doc, pageUrl, aHTMLString) {
    this._logger.debug("parseHtmlDoc: Building doc");

    // firefox 12 and newer.
    // https://developer.mozilla.org/en-US/docs/nsIDOMParser
    var parser = Components.classes["@mozilla.org/xmlextras/domparser;1"]
                 .createInstance(Components.interfaces.nsIDOMParser);
    // set document URI so it'll appear in console if there is a parse error.
    // we default security 'principal' and base URI.
    // TODO: is this the URL we retrieved aHTMLString from or the
    // URL containing the thumbnail/link?
    // TODO: Starting with Firefox 50, due to Firefox Bug 1237080, this warns:
    // Creating DOMParser without a principal is deprecated.
    parser.init(null, doc.documentURIObject, null);
    var tempdoc = parser.parseFromString(aHTMLString, "text/html");
    var body = tempdoc.body;
    
    // this._logger.debug("\n\n\n\nDOC tree:\n" + body.outerHTML + "\n\n\n\n");
    
    return {'doc': tempdoc, 'body': body};
  },


  getImgFromSelectors : function(body, selectors) {
    for (var i in selectors) {
      var selector = selectors[i];
      this._logger.debug("  Seeking with selector '" + selector + "'");
      let node = null;
      try {
        node = body.querySelector(selector);
      } catch (e) {
        ThumbnailZoomPlus._logExceptionToConsole("getImgFromSelectors", e);
      }
      if (node != null) {
        /*
           Get URL from <img src=>, <a href=>
         */
        let src = node.getAttribute("src") || node.getAttribute("href");
        this._logger.debug("  Found node " + node.localName + " url " + src);
        return src;
      }
    }
    return null;
  },
  

  /**
   * _getImageFromLinkedPageGen is a generator which reads the html doc
   * at specified pageUrl and calls pageCompletionFunc when it has determined
   * the appropriate image URL.  It operates asynchronously (and thus can call
   * pageCompletionFunc after it returns).  Each yield of the generator 
   * corresponds to an update of the html page's loading.  The generator is
   * created and invoked from getImageFromLinkedPage().
   */
  _getImageFromLinkedPageGen : function(doc, pageUrl, flags, invocationNumber,
                                           pageCompletionFunc,
                                           getImageFromHtmlFunc)
  {
    this._logger.debug("_getImageFromLinkedPageGen for " + pageUrl +
                 " invocationNumber " + invocationNumber);

    // The first call to generator.send() passes in the generator itself.
    let generator = yield undefined;
    
    let req = Components.classes["@mozilla.org/xmlextras/xmlhttprequest;1"].createInstance();

    // Call the generator's next() function whenever readystate is updated.
    req.onreadystatechange = function() {
      if (req.readyState >= req.HEADERS_RECEIVED) {
        try {
          if (generator) {
              generator.next();
          }
        } catch (e if e instanceof StopIteration) {
          // normal completion of generator.
        } catch (e) {
          ThumbnailZoomPlus._logExceptionToConsole("_getImageFromLinkedPageGen", e);
        }

      }
    };

    // req.responseType = "document";
    // req.timeout = 5000; // 5-second timeout (not supported for synchronous call)
    let asynchronous = true;
    req.open('GET', pageUrl, asynchronous);
    req.setRequestHeader('Accept', 'text/html');
    req.send();

    // Wait for headers to be available.
    this._logger.debug("_getImageFromLinkedPageGen: waiting for headers");
    yield undefined;
    
    if (invocationNumber != ThumbnailZoomPlus.Pages.OthersIndirect.invocationNumber) {
      // This request is obsolete.
      this._logger.debug("_getImageFromLinkedPageGen: aborting obsolete request.");
      // we don't abort since it causes 'already executing generator' error in generator.next() call above:
      // disabled: req.abort();
      generator = null;
      return;
    }
    
    if (req.status != 200) {
      // error from site
      this._logger.debug("_getImageFromLinkedPageGen: site returned error " + req.statusText);
      pageCompletionFunc(null);
    }

    // Check the doc type so we don't e.g. try to parse an image as if it were html.
    let docType = req.getResponseHeader('Content-Type');
    if (! /text\/html|application\/json/.test(docType)) {
      // json is for gfycat.com, for which we run an ajax query which returns json.
      this._logger.debug("_getImageFromLinkedPageGen: unsupported doc type returned: " + docType);
      pageCompletionFunc(null);
    }

    // Wait for content to be done loading.
    while (req.readyState < req.DONE) {
      this._logger.debug("_getImageFromLinkedPageGen: waiting for body; readyState=" + req.readyState);
      this._logger.debug("_getImageFromLinkedPageGen:   invocationNumber=" + invocationNumber + 
                   "; this.invocationNumber=" + ThumbnailZoomPlus.Pages.OthersIndirect.invocationNumber);
      yield undefined;
      if (invocationNumber != ThumbnailZoomPlus.Pages.OthersIndirect.invocationNumber) {
        // This request is obsolete.
        ThumbnailZoomPlus.debugToConsole("_getImageFromLinkedPageGen: aborting obsolete request." + pageURl);
        // we don't abort since it causes 'already executing generator' error in generator.next() call above:
        // disabled: req.abort();
        generator = null;
        return;
      }
    }
    
    var aHTMLString = req.responseText;
    if (! aHTMLString) {
      ThumbnailZoomPlus.debugToConsole("_getImageFromLinkedPageGen: site returned empty/null text " + aHTMLString);
      pageCompletionFunc(null);
    }
    // parseFragment won't run javascript so we need to not ignore the contents
    // of <noscript> tags.  Remove them.
    aHTMLString = aHTMLString.replace(/\<\/?noscript[^>]*\>/ig, "");
    this._logger.debug("  Got doc type " + docType + ":" + aHTMLString);
    
    // result is a url or an array of them.
    let result = getImageFromHtmlFunc(doc, pageUrl, flags, aHTMLString);

    pageCompletionFunc(result);
  },


  // getImageFromLinkedPage calls pageCompletionFunc with the URL of an image or
  // an array of them, as determined by analyzing
  // the html at the specified URL.  
  // getImageFromHtmlFunc() is supplied by the caller, and is called as:
  //   getImageFromHtmlFunc(doc, pageUrl,aHTMLString).  Returns "deferred".
  getImageFromLinkedPage : function(doc, pageUrl, flags, invocationNumber, pageCompletionFunc,
                                    getImageFromHtmlFunc)
  {
    ThumbnailZoomPlus.debugToConsole("getImageFromLinkedPage from page " + pageUrl);
    if (! ThumbnailZoomPlus.FilterService.allowProtocolOfURL(pageUrl, true)) {
      return null;
    }
    try {
      let generator = this._getImageFromLinkedPageGen(doc, pageUrl, flags, invocationNumber, 
                                                pageCompletionFunc, 
                                                getImageFromHtmlFunc);
      
      // start the generator.
      generator.next();
      generator.send(generator);
    } catch (e) {
      ThumbnailZoomPlus._logExceptionToConsole("getImageFromLinkedPage", e);
    }
    
    return "deferred";
  }

};

/**
 * Constructor.
 */
(function() { this._init(); }).apply(ThumbnailZoomPlus.PagesIndirect);
