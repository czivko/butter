/* This Source Code Form is subject to the terms of the MIT license
 * If a copy of the MIT license was not distributed with this file, you can
 * obtain one at https://raw.github.com/mozilla/butter/master/LICENSE */
/*jshint evil:true*/

define( [
          "core/logger", "core/eventmanager", "util/uri",
          "util/warn", "../../external/PluginDetect/PluginDetect_Flash"
        ],
        function(
          Logger, EventManager, URI,
          Warn, PluginDetect
        ){

  // regex to determine the type of player we need to use based on the provided url
  var __urlRegex = /(?:http:\/\/www\.|http:\/\/|www\.|\.|^)(youtu|vimeo|soundcloud|baseplayer)/;

      // how long to wait for the status of something in checkTimeoutLoop
  var STATUS_INTERVAL = 100,
      // timeout duration to wait for popcorn players to exist
      PLAYER_WAIT_DURATION = 10000,
      // timeout duration to wait for media to be ready
      MEDIA_WAIT_DURATION = 10000;

  // Hard coded value for now. We need to chat with whoever is in charge of Mozilla's
  // PFS2 instance to see if we can use the service / what limitations there might be
  var MIN_FLASH_VERSION = 11,

      FLASH_WARNING_TEXT = "Your web browser has an outdated Flash plugin." +
        " Flash media may not function as expected. Check your plugin version" +
        " using <a href=\"https://www.mozilla.org/plugincheck\">Mozilla's plugin" +
        " checking service</a>. Click <a href=\"#\" class=\"close-button\">here</a> to remove this warning.";

  /* The Popcorn-Wrapper wraps various functionality and setup associated with
   * creating, updating, and removing associated data with Popcorn.js.
   */
  return function ( mediaId, options ){

    var _id = mediaId,
        _logger = new Logger( _id + "::PopcornWrapper" ),
        _popcornEvents = options.popcornEvents || {},
        _onPrepare = options.prepare || function(){},
        _onFail = options.fail || function(){},
        _onTimeout = options.timeout || function(){},
        _popcorn,
        _mediaReady = false,
        _mediaType,
        _interruptLoad = false,
        _this = this,
        _makeVideoURLsUnique = options.makeVideoURLsUnique,
        _checkedFlashVersion = false;

    /* Destroy popcorn bindings specfically without touching other discovered
     * settings
     */
    this.unbind = function(){
      if ( _popcorn ) {
        try{
          _popcorn.destroy();
          _popcorn = undefined;
        }
        catch( e ){
          _logger.log( "WARNING: Popcorn did NOT get destroyed properly: \n" + e.message + "\n" + e.stack );
        }
      }
    };

    /* Setup any handlers that were defined in the options passed into
     * popcorn wrapper. Events such as timeupdate, paused, etc
     */
    function addPopcornHandlers(){
      for ( var eventName in _popcornEvents ){
        if ( _popcornEvents.hasOwnProperty( eventName ) ) {
          _popcorn.on( eventName, _popcornEvents[ eventName ] );
        }
      } //for
    } //addPopcornHandlers

    // Cancel loading or preparing of media whilst attempting to setup
    this.interruptLoad = function(){
      _interruptLoad = true;
    }; //interrupt

    // Update Popcorn events with data from a butter trackevent
    this.synchronizeEvent = function( trackEvent, newOptions ) {
      var options = trackEvent.popcornOptions,
          popcornId = trackEvent.id,
          popcornEvent = null;

      function createTrackEvent() {

        if ( _popcorn.getTrackEvent( popcornId ) ) {
          _popcorn[ trackEvent.type ]( popcornId, newOptions );
        } else {
          _popcorn[ trackEvent.type ]( popcornId, options );
        }

        popcornEvent = _popcorn.getTrackEvent( popcornId );
        trackEvent.popcornTrackEvent = popcornEvent;

        trackEvent.popcornOptions.start = +popcornEvent.start;
        trackEvent.popcornOptions.end = +popcornEvent.end;

        if ( trackEvent.view ) {
          if ( popcornEvent.toString ) {
            if ( trackEvent.type === "sequencer" ) {
              if ( !trackEvent.popcornOptions.hidden ) {
                trackEvent.view.element.classList.add( "sequencer-video" );
                trackEvent.view.element.classList.remove( "sequencer-audio" );
              } else {
                trackEvent.view.element.classList.add( "sequencer-audio" );
                trackEvent.view.element.classList.remove( "sequencer-video" );
              }
            }
          }

          trackEvent.view.update( trackEvent.popcornOptions );

          // make sure we have a reference to the trackevent before calling toString
          if ( trackEvent.popcornTrackEvent ) {
            trackEvent.view.elementText = trackEvent.popcornTrackEvent.toString();
            // we should only get here if no exceptions happened
            trackEvent.dispatch( "trackeventupdated", trackEvent );
          }
        }
      }

      if ( _popcorn ) {
        // make sure the plugin is still included
        if ( _popcorn[ trackEvent.type ] ) {
          if ( trackEvent.type === "sequencer" ) {
            waitForPopcorn( createTrackEvent, function() {
              throw "Your media seems to be taking a long time to load. Review your media URL(s) or continue waiting.";
            }, findMediaType( trackEvent.popcornOptions.source ) );
          } else {
            createTrackEvent();
          }
        }
      }
    };

    // Destroy a Popcorn trackevent
    this.destroyEvent = function( trackEvent ){
      var popcornId = trackEvent.id;

      // ensure the trackevent actually exists before we remove it
      if ( _popcorn ) {
        if ( popcornId && _popcorn.getTrackEvent( popcornId ) ) {
          _popcorn.removeTrackEvent( popcornId );
        } //if

      } //if
    }; //destroyEvent

    /* Create functions for various failure and success cases,
     * generate the Popcorn string and ensures our player is ready
     * before we actually create the Popcorn instance and notify the
     * user.
     */
    this.prepare = function( url, target, popcornOptions, callbacks, scripts ){
      var urlsFromString;

      _mediaReady = false;

      // called when timeout occurs preparing popcorn
      function popcornTimeoutWrapper( e ) {
        _interruptLoad = true;
        _onTimeout( e );
      }

      // called when timeout occurs preparing media
      function mediaTimeoutWrapper( e ) {
        _onTimeout( e );
      }

      // called when there's a serious failure in preparing popcorn
      function failureWrapper( e ) {
        _interruptLoad = true;
        _logger.log( e );
        _onFail( e );
      }

      // attempt to grab the first url for a type inspection
      // In the case of URL being a string, check that it doesn't follow our format for
      // Null Video (EG #t=,200). Without the check it incorrectly will splice on the comma.
      var firstUrl = url;
      if ( typeof( url ) !== "string" ) {
        if ( !url.length ) {
          throw "URL is invalid: empty array or not a string.";
        }
        else {
          firstUrl = url[ 0 ];
        }
      }
      else if ( url.indexOf( "#t" ) !== 0 && url.indexOf( "," ) > -1 ) {
        urlsFromString = url.split( "," );
        firstUrl = urlsFromString[ 0 ];
        url = urlsFromString;
      }

      // discover and stash the type of media as dictated by the url
      setMediaType( firstUrl );

      // if there isn't a target, we can't really set anything up, so stop here
      if ( !target ) {
        _logger.log( "Warning: tried to prepare media with null target." );
        return;
      }

      // only enter this block if popcorn doesn't already exist (call clear() first to destroy it)
      if ( !_popcorn ) {
        try {
          // make sure popcorn is setup properly: players, etc
          waitForPopcorn( function(){
            // construct the correct dom infrastructure if required
            constructPlayer( target );
            // generate a function which will create a popcorn instance when entered into the page
            createPopcorn( generatePopcornString( popcornOptions, url, target, null, callbacks, scripts ) );
            // once popcorn is created, attach listeners to it to detect state
            addPopcornHandlers();
            // wait for the media to become available and notify the user, or timeout
            waitForMedia( _onPrepare, mediaTimeoutWrapper );
          }, popcornTimeoutWrapper, _mediaType );
        }
        catch( e ) {
          // if we've reached here, we have an internal failure in butter or popcorn
          failureWrapper( e );
        }
      }

    };

    /* Return the type of media that is going to be used
     * based on the specified url
     */
    function findMediaType( url ){
      var regexResult = __urlRegex.exec( url ),
          // if the regex didn't return anything we know it's an HTML5 source
          mediaType = "object",
          flashVersion;
      if ( regexResult ) {

        mediaType = regexResult[ 1 ];
        // our regex only handles youtu ( incase the url looks something like youtu.be )
        if ( mediaType === "youtu" ) {
          mediaType = "youtube";
        }

        if ( !_checkedFlashVersion ) {
          _checkedFlashVersion = true;
          flashVersion = PluginDetect.getVersion( "Flash" );
          if ( flashVersion && +flashVersion.split( "," )[ 0 ] < MIN_FLASH_VERSION ) {
            Warn.showWarning( FLASH_WARNING_TEXT );
          }
        }
      }
      return mediaType;
    }

    /* Sets the type of media that is going to be used
     * based on the specified url
     */
    function setMediaType( url ) {
      _mediaType = findMediaType( url );
      return _mediaType;
    }

    /* If possible and necessary, reformat the dom to conform to the url type specified
     * for the media. For example, youtube/vimeo players like <div>'s, not <video>'s to
     * dwell in.
     */
    function constructPlayer( target ){
      var targetElement = document.getElementById( target );

      if ( _mediaType !== "object" && targetElement ) {
        if ( [ "VIDEO", "AUDIO" ].indexOf( targetElement.nodeName ) !== -1 ) {
          var parentNode = targetElement.parentNode,
              newElement = document.createElement( "div" ),
              videoAttributes = [ "controls", "preload", "autoplay", "loop", "muted", "poster", "src" ],
              attributes;

          newElement.id = targetElement.id;
          attributes = targetElement.attributes;
          if ( attributes ) {
            for( var i = attributes.length - 1; i >= 0; i-- ) {
              var name = attributes[ i ].nodeName;
              if ( videoAttributes.indexOf( name ) === -1 ) {
                newElement.setAttribute( name, targetElement.getAttribute( name ) );
              }
            }
          }
          if ( targetElement.className ) {
            newElement.className = targetElement.className;
          }
          parentNode.replaceChild( newElement, targetElement );
          newElement.setAttribute( "data-butter", "media" );
        }
      }
    }

    /* Determine which player is needed (usually based on the result of setMediaType)
     * and create a stringified representation of the Popcorn constructor (usually to
     * insert in a script tag).
     */
    var generatePopcornString = this.generatePopcornString = function( popcornOptions, url, target, method, callbacks, scripts, trackEvents ){

      callbacks = callbacks || {};
      scripts = scripts || {};

      var popcornString = "",
          optionString,
          saveOptions,
          i,
          option;

      // Chrome currently won't load multiple copies of the same video.
      // See http://code.google.com/p/chromium/issues/detail?id=31014.
      // Munge the url so we get a unique media resource key.
      // However if set in the config, don't append this
      url = typeof url === "string" ? [ url ] : url;
      if ( _makeVideoURLsUnique ) {
        for( i=0; i<url.length; i++ ){
          url[ i ] = URI.makeUnique( url[ i ] ).toString();
        }
      }
      // Transform into a string of URLs (i.e., array string)
      url = JSON.stringify( url );

      // prepare popcornOptions as a string
      if ( popcornOptions ) {
        popcornOptions = ", " + JSON.stringify( popcornOptions );
      } else {
        popcornOptions = ", {}";
      }

      // attempt to get the target element, and continue with a warning if a failure occurs
      if ( typeof( target ) !== "string" ) {
        if ( target && target.id ) {
          target = target.id;
        }
        else{
          _logger.log( "WARNING: Unexpected non-string Popcorn target: " + target );
        }
      } //if

      // if the media type hasn't been discovered yet, bail, since it's pointless to continue
      if ( !_mediaType ) {
        throw new Error( "Media type not generated yet. Please specify a url for media objects before generating a popcorn string." );
      }

      if ( scripts.init ) {
        popcornString += scripts.init + "\n";
      }
      if ( callbacks.init ) {
        popcornString += callbacks.init + "();\n";
      }

      // special case for basePlayer, since it doesn't require as much of a harness
      if ( _mediaType === "baseplayer" ) {
        popcornString +=  "Popcorn.player( 'baseplayer' );\n" +
                          "var popcorn = Popcorn.baseplayer( '#" + target + "' " + popcornOptions + " );\n";
      } else {
        // just try to use Popcorn.smart to detect/setup video
        popcornString += "var popcorn = Popcorn.smart( '#" + target + "', " + url + popcornOptions + " );\n";
      }

      if ( scripts.beforeEvents ) {
        popcornString += scripts.beforeEvents + "\n";
      }
      if ( callbacks.beforeEvents ) {
        popcornString += callbacks.beforeEvents + "( popcorn );\n";
      }

      // if popcorn was built successfully
      if ( _popcorn ) {

        if ( trackEvents ) {
          for ( i = trackEvents.length - 1; i >= 0; i-- ) {
            popcornOptions = trackEvents[ i ].popcornOptions;

            saveOptions = {};
            for ( option in popcornOptions ) {
              if ( popcornOptions.hasOwnProperty( option ) ) {
                if ( popcornOptions[ option ] !== undefined ) {
                  saveOptions[ option ] = popcornOptions[ option ];
                }
              }
            }

            //stringify will throw an error on circular data structures
            try {
              //pretty print with 4 spaces per indent
              optionString = JSON.stringify( saveOptions, null, 4 );
            } catch ( jsonError ) {
              optionString = false;
              _logger.log( "WARNING: Unable to export event options: \n" + jsonError.message );
            }

            if ( optionString ) {
              popcornString += "popcorn." + trackEvents[ i ].type + "(" +
                optionString + ");\n";
            }

          }

        }

      }

      if ( scripts.afterEvents ) {
        popcornString += scripts.afterEvents + "\n";
      }
      if ( callbacks.afterEvents ) {
        popcornString += callbacks.afterEvents + "( popcorn );\n";
      }

      popcornString += "popcorn.controls( false );\n";

      // if the `method` var is blank, the user probably just wanted an inline function without an onLoad wrapper
      method = method || "inline";

      // ... otherwise, wrap the function in an onLoad wrapper
      if ( method === "event" ) {
        popcornString = "\ndocument.addEventListener('DOMContentLoaded',function(e){\n" + popcornString;
        popcornString += "\n},false);";
      }
      else {
        popcornString = popcornString + "\nreturn popcorn;";
      } //if

      return popcornString;
    };

    /* Create a Popcorn instace in the page. Try just running the generated function first (from popcornString)
     * and insert it as a script in the head if that fails.
     */
    function createPopcorn( popcornString ){
      var popcornFunction = new Function( "", popcornString ),
          popcorn = popcornFunction();
      if ( !popcorn ) {
        var popcornScript = document.createElement( "script" );
        popcornScript.innerHTML = popcornString;
        document.head.appendChild( popcornScript );
        popcorn = window.Popcorn.instances[ window.Popcorn.instances.length - 1 ];
      }
      _popcorn = popcorn;
    }

    /* Abstract the problem of waiting for some condition to occur with a timeout. Loop on checkFunction,
     * calling readyCallback when it succeeds, or calling timeoutCallback after MEDIA_WAIT_DURATION milliseconds.
     */
    function checkTimeoutLoop( checkFunction, readyCallback, timeoutCallback ){
      var ready = false;

      // perform one check
      function doCheck(){

        if ( _interruptLoad ) {
          return;
        }

        // run the check function
        ready = checkFunction();
        if ( ready ) {
          // if success, call the ready callback
          readyCallback();
        }
        else {
          // otherwise, prepare for another loop
          setTimeout( doCheck, STATUS_INTERVAL );
        }
      }

      // set a timeout to occur after timeoutDuration milliseconds
      setTimeout(function(){
        // if success hasn't already occured, call timeoutCallback
        if ( !ready ) {
          timeoutCallback();
        }
      }, MEDIA_WAIT_DURATION );

      //init
      doCheck();
    }

    /* Wait for the media to return a sane readyState and duration so we can interact
     * with it (uses checkTimeoutLoop).
     */
    function waitForMedia( readyCallback, timeoutCallback ){
      checkTimeoutLoop(function(){
        // Make sure _popcorn still exists (e.g., destroy() hasn't been called),
        // that we're ready, and that we have a duration.
        _mediaReady = ( _popcorn && ( _popcorn.media.readyState >= 1 && _popcorn.duration() > 0 ) );

        return _mediaReady;
      }, readyCallback, timeoutCallback, MEDIA_WAIT_DURATION );
    }

    /* Wait for Popcorn to be set up and to have the required players load (uses
     * checkTimeoutLoop).
     */
    function waitForPopcorn( readyCallback, timeoutCallback, mediaType ) {
      if ( mediaType !== "object" ) {
        checkTimeoutLoop(function(){
          return ( !!window.Popcorn[ mediaType ] );
        }, readyCallback, timeoutCallback, PLAYER_WAIT_DURATION );
      }
      else{
        readyCallback();
      }
    }

    // Passthrough to the Popcorn instances play method
    this.play = function(){
      if ( _mediaReady && _popcorn.paused() ) {
        _popcorn.play();
      }
    };

    // Passthrough to the Popcorn instances pause method
    this.pause = function(){
      if ( _mediaReady && !_popcorn.paused() ) {
        _popcorn.pause();
      }
    };

    // XXX: SoundCloud has a bug (reported by us, but as yet unfixed) which blocks
    // loading of a second iframe/player if the iframe for the first is removed
    // from the DOM.  We can simply move old ones to a quarantine div, hidden from
    // the user for now (see #2630).  We lazily create and memoize the instance.
    function getSoundCloudQuarantine() {
      if ( getSoundCloudQuarantine.instance ) {
        return getSoundCloudQuarantine.instance;
      }

      var quarantine = document.createElement( "div" );
      quarantine.style.width = "0px";
      quarantine.style.height = "0px";
      quarantine.style.overflow = "hidden";
      quarantine.style.visibility = "hidden";
      document.body.appendChild( quarantine );

      getSoundCloudQuarantine.instance = quarantine;
      return quarantine;
    }

    // Wipe the current Popcorn instance and anything it created
    this.clear = function( container ) {
      if ( typeof( container ) === "string" ) {
        container = document.getElementById( container );
      }
      if ( !container ) {
        _logger.log( "Warning: tried to clear media with null target." );
        return;
      }

      function isSoundCloud( p ) {
        return !!(
          p.media       &&
          p.media._util &&
          p.media._util.type === "SoundCloud" );
      }

      if ( _popcorn ) {
        if ( isSoundCloud( _popcorn ) ) {
          // XXX: pull the SoundCloud iframe element out of our video div, and quarantine
          // so we don't delete it, and block loading future SoundCloud instances. See above.
          var soundCloudParent = _popcorn.media.parentNode,
              soundCloudIframe = soundCloudParent.querySelector( "iframe" );
          if ( soundCloudIframe ) {
            getSoundCloudQuarantine().appendChild( soundCloudIframe );
          }
        }
        _this.unbind();
      }

      // Tear-down old instances, special-casing SoundCloud removal, see above.
      while( container.firstChild ) {
        container.removeChild( container.firstChild );
      }

      if ( [ "AUDIO", "VIDEO" ].indexOf( container.nodeName ) > -1 ) {
        container.currentSrc = "";
        container.src = "";
        container.removeAttribute( "src" );
      }
    };

    Object.defineProperties( this, {
      volume: {
        enumerable: true,
        set: function( val ){
          if ( _popcorn ) {
            _popcorn.volume( val );
          } //if
        },
        get: function() {
          if ( _popcorn ) {
            return _popcorn.volume();
          }
          return false;
        }
      },
      muted: {
        enumerable: true,
        set: function( val ) {
          if ( _popcorn ) {
            if ( val ) {
              _popcorn.mute();
            }
            else {
              _popcorn.unmute();
            } //if
          } //if
        },
        get: function() {
          if ( _popcorn ) {
            return _popcorn.muted();
          }
          return false;
        }
      },
      currentTime: {
        enumerable: true,
        set: function( val ) {
          if ( _mediaReady && _popcorn ) {
            _popcorn.currentTime( val );
          } //if
        },
        get: function() {
          if ( _popcorn ) {
            return _popcorn.currentTime();
          }
          return 0;
        }
      },
      duration: {
        enumerable: true,
        get: function() {
          if ( _popcorn ) {
            return _popcorn.duration();
          } //if
          return 0;
        }
      },
      popcorn: {
        enumerable: true,
        get: function(){
          return _popcorn;
        }
      },
      paused: {
        enumerable: true,
        get: function() {
          if ( _popcorn ) {
            return _popcorn.paused();
          } //if
          return true;
        },
        set: function( val ) {
          if ( _popcorn ) {
            if ( val ) {
              _this.pause();
            }
            else {
              _this.play();
            } //if
          } //if
        }
      } //paused
    });

  };

});
