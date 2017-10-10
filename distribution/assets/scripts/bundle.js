(function loader(mappings, entryPoints, options) {

  if (entryPoints.length > 1) {
    throw new Error(
      "LiveReactLoad supports only one entry point at the moment"
    )
  }

  var entryId = entryPoints[0];

  var scope = {
    mappings: mappings,
    cache: {},
    reloading: false,
    reloadHooks: {},
    reload: function (fn) {
      scope.reloading = true;
      try {
        fn();
      } finally {
        scope.reloading = false;
      }
    }
  };


  function startClient() {
    if (!options.clientEnabled) {
      return;
    }
    if (typeof window.WebSocket === "undefined") {
      warn("WebSocket API not available, reloading is disabled");
      return;
    }
    var protocol = window.location.protocol === "https:" ? "wss" : "ws";
    var url = protocol + "://" + (options.host || window.location.hostname);
    if (options.port != 80) {
      url = url + ":" + options.port;
    }
    var ws = new WebSocket(url);
    ws.onopen = function () {
      info("WebSocket client listening for changes...");
    };
    ws.onmessage = function (m) {
      var msg = JSON.parse(m.data);
      if (msg.type === "change") {
        handleBundleChange(msg.data);
      } else if (msg.type === "bundle_error") {
        handleBundleError(msg.data);
      }
    }
  }

  function compile(mapping) {
    var body = mapping[0];
    if (typeof body !== "function") {
      debug("Compiling module", mapping[2])
      var compiled = compileModule(body, mapping[2].sourcemap);
      mapping[0] = compiled;
      mapping[2].source = body;
    }
  }

  function compileModule(source, sourcemap) {
    var toModule = new Function(
      "__livereactload_source", "__livereactload_sourcemap",
      "return eval('function __livereactload_module(require, module, exports){\\n' + __livereactload_source + '\\n}; __livereactload_module;' + (__livereactload_sourcemap || ''));"
    );
    return toModule(source, sourcemap)
  }

  function unknownUseCase() {
    throw new Error(
      "Unknown use-case encountered! Please raise an issue: " +
      "https://github.com/milankinen/livereactload/issues"
    )
  }

  // returns loaded module from cache or if not found, then
  // loads it from the source and caches it
  function load(id, recur) {
    var mappings = scope.mappings;
    var cache = scope.cache;

    if (!cache[id]) {
      if (!mappings[id]) {
        var req = typeof require == "function" && require;
        if (req) return req(id);
        var error = new Error("Cannot find module '" + id + "'");
        error.code = "MODULE_NOT_FOUND";
        throw error;
      }

      var hook = scope.reloadHooks[id];
      var module = cache[id] = {
        exports: {},
        __accepted: false,
        onReload: function (hook) {
          scope.reloadHooks[id] = hook;
        }
      };

      mappings[id][0].call(module.exports, function require(path) {
        var targetId = mappings[id][1][path];
        return load(targetId ? targetId : path);
      }, module, module.exports, unknownUseCase, mappings, cache, entryPoints);

      if (scope.reloading && typeof hook === "function") {
        // it's important **not** to assign to module.__accepted because it would point
        // to the old module object during the reload event!
        cache[id].__accepted = hook()
      }

    }
    return cache[id].exports;
  }

  /**
   * Patches the existing modules with new sources and returns a list of changes
   * (module id and old mapping. ATTENTION: This function does not do any reloading yet.
   *
   * @param mappings
   *    New mappings
   * @returns {Array}
   *    List of changes
   */
  function patch(mappings) {
    var compile = scope.compile;
    var changes = [];

    keys(mappings).forEach(function (id) {
      var old = scope.mappings[id];
      var mapping = mappings[id];
      var meta = mapping[2];
      if (!old || old[2].hash !== meta.hash) {
        compile(mapping);
        scope.mappings[id] = mapping;
        changes.push([id, old]);
      }
    });
    return changes;
  }

  /**
   * Reloads modules based on the given changes. If reloading fails, this function
   * tries to restore old implementation.
   *
   * @param changes
   *    Changes array received from "patch" function
   */
  function reload(changes) {
    var changedModules = changes.map(function (c) {
      return c[0];
    });
    var newMods = changes.filter(function (c) {
      return !c[1];
    }).map(function (c) {
      return c[0];
    });

    scope.reload(function () {
      try {
        info("Applying changes...");
        debug("Changed modules", changedModules);
        debug("New modules", newMods);
        evaluate(entryId, {});
        info("Reload complete!");
      } catch (e) {
        error("Error occurred while reloading changes. Restoring old implementation...");
        console.error(e);
        console.error(e.stack);
        try {
          restore();
          evaluate(entryId, {});
          info("Restored!");
        } catch (re) {
          error("Restore failed. You may need to refresh your browser... :-/");
          console.error(re);
          console.error(re.stack);
        }
      }
    })


    function evaluate(id, changeCache) {
      if (id in changeCache) {
        debug("Circular dependency detected for module", id, "not traversing any further...");
        return changeCache[id];
      }
      if (isExternalModule(id)) {
        debug("Module", id, "is an external module. Do not reload");
        return false;
      }
      var module = getModule(id);
      debug("Evaluate module details", module);

      // initially mark change status to follow module's change status
      // TODO: how to propagate change status from children to this without causing infinite recursion?
      var meChanged = contains(changedModules, id);
      changeCache[id] = meChanged;
      if (id in scope.cache) {
        delete scope.cache[id];
      }

      var deps = module.deps.filter(isLocalModule);
      var depsChanged = deps.map(function (dep) {
        return evaluate(dep, changeCache);
      });

      // In the case of circular dependencies, the module evaluation stops because of the
      // changeCache check above. Also module cache should be clear. However, if some circular
      // dependency (or its descendant) gets reloaded, it (re)loads new version of this
      // module back to cache. That's why we need to ensure that we're not
      //    1) reloading module twice (so that we don't break cross-refs)
      //    2) reload any new version if there is no need for reloading
      //
      // Hence the complex "scope.cache" stuff...
      //
      var isReloaded = module.cached !== undefined && id in scope.cache;
      var depChanged = any(depsChanged);

      if (isReloaded || depChanged || meChanged) {
        debug("Module changed", id, isReloaded, depChanged, meChanged);
        if (!isReloaded) {
          var msg = contains(newMods, id) ? " > Add new module   ::" : " > Reload module    ::";
          console.log(msg, id);
          load(id);
        } else {
          console.log(" > Already reloaded ::", id);
        }
        changeCache[id] = !allExportsProxies(id) && !isAccepted(id);
        return changeCache[id];
      } else {
        // restore old version of the module
        if (module.cached !== undefined) {
          scope.cache[id] = module.cached;
        }
        return false;
      }
    }

    function allExportsProxies(id) {
      var e = scope.cache[id].exports;
      return isProxy(e) || (isPlainObj(e) && all(vals(e), isProxy));

      function isProxy(x) {
        return x && !!x.__$$LiveReactLoadable;
      }
    }

    function isAccepted(id) {
      var accepted = scope.cache[id].__accepted;
      scope.cache[id].__accepted = false;
      if (accepted === true) {
        console.log(" > Manually accepted")
      }
      return accepted === true;
    }

    function restore() {
      changes.forEach(function (c) {
        var id = c[0], mapping = c[1];
        if (mapping) {
          debug("Restore old mapping", id);
          scope.mappings[id] = mapping;
        } else {
          debug("Delete new mapping", id);
          delete scope.mappings[id];
        }
      })
    }
  }

  function getModule(id) {
    return {
      deps: vals(scope.mappings[id][1]),
      meta: scope.mappings[id][2],
      cached: scope.cache[id]
    };
  }

  function handleBundleChange(newMappings) {
    info("Bundle changed");
    var changes = patch(newMappings);
    if (changes.length > 0) {
      reload(changes);
    } else {
      info("Nothing to reload");
    }
  }

  function handleBundleError(data) {
    error("Bundling error occurred");
    error(data.error);
  }


  // prepare mappings before starting the app
  forEachValue(scope.mappings, compile);

  if (options.babel) {
    if (isReactTransformEnabled(scope.mappings)) {
        info("LiveReactLoad Babel transform detected. Ready to rock!");
    } else {
      warn(
        "Could not detect LiveReactLoad transform (livereactload/babel-transform). " +
        "Please see instructions how to setup the transform:\n\n" +
        "https://github.com/milankinen/livereactload#installation"
      );
    }
  }

  scope.compile = compile;
  scope.load = load;

  debug("Options:", options);
  debug("Entries:", entryPoints, entryId);

  startClient();
  // standalone bundles may need the exports from entry module
  return load(entryId);


  // this function is stringified in browserify process and appended to the bundle
  // so these helper functions must be inlined into this function, otherwise
  // the function is not working

  function isReactTransformEnabled(mappings) {
    return any(vals(mappings), function (mapping) {
      var source = mapping[2].source;
      return source && source.indexOf("__$$LiveReactLoadable") !== -1;
    });
  }

  function isLocalModule(id) {
    return id.indexOf(options.nodeModulesRoot) === -1
  }

  function isExternalModule(id) {
    return !(id in scope.mappings);
  }

  function keys(obj) {
    return obj ? Object.keys(obj) : [];
  }

  function vals(obj) {
    return keys(obj).map(function (key) {
      return obj[key];
    });
  }

  function contains(col, val) {
    for (var i = 0; i < col.length; i++) {
      if (col[i] === val) return true;
    }
    return false;
  }

  function all(col, f) {
    if (!f) {
      f = function (x) {
        return x;
      };
    }
    for (var i = 0; i < col.length; i++) {
      if (!f(col[i])) return false;
    }
    return true;
  }

  function any(col, f) {
    if (!f) {
      f = function (x) {
        return x;
      };
    }
    for (var i = 0; i < col.length; i++) {
      if (f(col[i])) return true;
    }
    return false;
  }

  function forEachValue(obj, fn) {
    keys(obj).forEach(function (key) {
      if (obj.hasOwnProperty(key)) {
        fn(obj[key]);
      }
    });
  }

  function isPlainObj(x) {
    return typeof x == 'object' && x.constructor == Object;
  }

  function debug() {
    if (options.debug) {
      console.log.apply(console, ["LiveReactload [DEBUG] ::"].concat(Array.prototype.slice.call(arguments)));
    }
  }

  function info(msg) {
    console.info("LiveReactload ::", msg);
  }

  function warn(msg) {
    console.warn("LiveReactload ::", msg);
  }

  function error(msg) {
    console.error("LiveReactload ::", msg);
  }
})({
  "/Users/liam/Sites/Personal/portfolio/application/scripts/components/WorkItems.js": [
    "'use strict';\n\nObject.defineProperty(exports, \"__esModule\", {\n    value: true\n});\n\nvar _createClass = function () {\n    function defineProperties(target, props) {\n        for (var i = 0; i < props.length; i++) {\n            var descriptor = props[i];descriptor.enumerable = descriptor.enumerable || false;descriptor.configurable = true;if (\"value\" in descriptor) descriptor.writable = true;Object.defineProperty(target, descriptor.key, descriptor);\n        }\n    }return function (Constructor, protoProps, staticProps) {\n        if (protoProps) defineProperties(Constructor.prototype, protoProps);if (staticProps) defineProperties(Constructor, staticProps);return Constructor;\n    };\n}();\n\nfunction _classCallCheck(instance, Constructor) {\n    if (!(instance instanceof Constructor)) {\n        throw new TypeError(\"Cannot call a class as a function\");\n    }\n}\n\n/**\n * Work Items\n */\nvar WorkItems = function () {\n\n    /**\n     * @constructor\n     */\n    function WorkItems() {\n        var _this = this;\n\n        _classCallCheck(this, WorkItems);\n\n        // Elements\n        this.container = document.querySelector('[data-work=\"container\"]');\n        this.list = this.container.querySelector('[data-work=\"items\"]');\n        this.items = this.container.querySelectorAll('[data-work=\"item\"]');\n        this.media = this.container.querySelector('[data-work=\"media\"]');\n        this.video = this.container.querySelector('[data-work=\"video\"]');\n        this.videoSrc = this.video.querySelector('[data-video=\"src\"]');\n\n        this.pagination = this.container.querySelector('[data-work=\"pagination\"]');\n        this.paginationList = this.container.querySelector('[data-pagination=\"list\"]');\n\n        this.accents = this.container.querySelector('[data-work=\"accents\"]');\n        this.projectCount = this.accents.querySelector('[data-accent=\"project\"]');\n\n        console.log(this.accents);\n\n        // Generate Items\n        this.itemsArr = this.generateItemsArray(this.items);\n        this.itemsMap = this.generateItemsMap(this.items);\n        this.paginationItems = this.generatePaginationItems(this.items.length);\n\n        // Item Values\n        this.currentItem = 0;\n        this.prevItem = this.currentItem;\n\n        this.isAnimating = false;\n\n        this.mousePos = {};\n        this.mouseThreshold = 150;\n\n        window.addEventListener('mousemove', this.onMouseMove.bind(this));\n        window.addEventListener('mousewheel', this.onMouseWheel.bind(this));\n\n        // Initialize application\n        setTimeout(function () {\n            return _this.init();\n        }, 500);\n    }\n\n    /**\n     * Initialize the active item.\n     *\n     * @method\n     * @returns void\n     */\n\n    _createClass(WorkItems, [{\n        key: 'init',\n        value: function init() {\n\n            this.container.classList.remove('transitioning');\n            this.pagination.classList.remove('loading');\n            this.setActiveItem(0);\n        }\n\n        /**\n         * Set th active item in the list\n         *\n         * @method\n         * @param {Number} index\n         * @returns void\n         */\n\n    }, {\n        key: 'setActiveItem',\n        value: function setActiveItem(index) {\n            var _this2 = this;\n\n            if (!this.isAnimating && index >= 0 && index <= this.itemsArr.length - 1) {\n\n                this.isAnimating = true;\n\n                this.prevItem = this.currentItem;\n                this.currentItem = index;\n\n                this.container.classList.add('transitioning');\n                this.itemsMap[this.prevItem].el.classList.remove('active');\n\n                this.paginationItems[this.prevItem].classList.remove('active');\n                this.paginationList.style.transform = 'translateX(-' + 46 * this.currentItem + 'px)';\n\n                // Delay the next item animations.\n                setTimeout(function () {\n\n                    _this2.isAnimating = false;\n\n                    _this2.videoSrc.src = _this2.itemsMap[_this2.currentItem].el.getAttribute('data-media');\n\n                    _this2.container.classList.remove('transitioning');\n                    _this2.itemsMap[_this2.currentItem].el.classList.add('active');\n                    _this2.paginationItems[_this2.currentItem].classList.add('active');\n\n                    _this2.projectCount.innerHTML = '0' + (index + 1);\n                }, 1500);\n            }\n        }\n\n        /**\n         * Generate an array from the work items in the DOM.\n         *\n         *\n         * @param {NodeList} nodeList\n         * @returns {Array}\n         */\n\n    }, {\n        key: 'generateItemsArray',\n        value: function generateItemsArray(nodeList) {\n\n            var items = [];\n\n            nodeList.forEach(function (element, index) {\n                return items.push({\n                    index: index,\n                    el: element\n                });\n            });\n\n            return items;\n        }\n\n        /**\n         * Generate a map of the items\n         *\n         * @method\n         * @param {NodeList} nodeList\n         * @returns {Object}\n         */\n\n    }, {\n        key: 'generateItemsMap',\n        value: function generateItemsMap(nodeList) {\n\n            var map = {};\n\n            nodeList.forEach(function (element, index) {\n\n                var name = element.getAttribute('data-name');\n\n                map[index] = {\n                    index: index,\n                    name: name,\n                    el: element\n                };\n            });\n\n            return map;\n        }\n\n        /**\n         * Generate the items for the pagination\n         *\n         * @method\n         * @param {Number} count\n         * @returns {Object}\n         */\n\n    }, {\n        key: 'generatePaginationItems',\n        value: function generatePaginationItems(count) {\n\n            var map = {};\n\n            for (var i = 0; i < count; i++) {\n\n                var item = document.createElement('li');\n                item.classList.add('work-pagination__item');\n                item.setAttribute('data-pagination', 'item');\n                item.setAttribute('data-index', i);\n                item.addEventListener('click', this.onPaginationClick.bind(this));\n\n                if (i === 0) item.classList.add('active');\n\n                this.paginationList.appendChild(item);\n\n                map[i] = item;\n            }\n\n            return map;\n        }\n\n        /**\n         * Update the moving elements within the app based on mouse position.\n         *\n         * @method\n         * @returns void\n         */\n\n    }, {\n        key: 'updateMovement',\n        value: function updateMovement() {\n\n            this.video.style.transform = 'rotateX(' + this.mousePos.x + 'deg) rotateY(' + this.mousePos.y + 'deg)';\n            this.itemsMap[this.currentItem].el.style.transform = 'translateX(' + Math.round(this.mousePos.y * 100) / 100 + '%) translateY(-50%)';\n            this.pagination.style.transform = 'translateX(' + this.mousePos.y + '%)';\n            this.pagination.style.marginBottom = this.mousePos.x + 'px';\n        }\n\n        /**\n         * On pagination item click, change item.\n         *\n         * @method\n         * @param {Object} event\n         * @returns void\n         */\n\n    }, {\n        key: 'onPaginationClick',\n        value: function onPaginationClick(event) {\n            this.setActiveItem(parseInt(event.currentTarget.getAttribute('data-index')));\n        }\n\n        /**\n         * On scroll, change item.\n         *\n         * @method\n         * @param {Object} event\n         * @returns void\n         */\n\n    }, {\n        key: 'onMouseWheel',\n        value: function onMouseWheel(event) {\n\n            event.preventDefault();\n\n            if (event.deltaY > this.mouseThreshold) this.setActiveItem(this.currentItem + 1);else if (event.deltaY < -this.mouseThreshold) this.setActiveItem(this.currentItem - 1);\n        }\n\n        /**\n         * On mouse move, set our X and Y\n         *\n         * @method\n         * @param {Object} event\n         * @returns void\n         */\n\n    }, {\n        key: 'onMouseMove',\n        value: function onMouseMove(event) {\n\n            this.mousePos = {\n                y: (0.5 - event.screenX / window.innerWidth) * 5,\n                x: (0.5 - event.screenY / window.innerHeight) * 5\n            };\n\n            this.updateMovement();\n        }\n    }]);\n\n    return WorkItems;\n}();\n\nexports.default = WorkItems;\n",
    {},
    {
      "id": "/Users/liam/Sites/Personal/portfolio/application/scripts/components/WorkItems.js",
      "hash": "EDu1+A",
      "browserifyId": "/Users/liam/Sites/Personal/portfolio/application/scripts/components/WorkItems.js",
      "sourcemap": "//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIldvcmtJdGVtcy5qcz92ZXJzaW9uPUVEdTErQSJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBOzs7SUFHcUIsd0JBR2pCOztBQUdBOzs7eUJBQWM7b0JBQUE7OzhCQUVWOztBQUNBO2FBQUEsQUFBSyxZQUFZLFNBQUEsQUFBUyxjQUExQixBQUFpQixBQUF1QixBQUN4QzthQUFBLEFBQUssT0FBTyxLQUFBLEFBQUssVUFBTCxBQUFlLGNBQTNCLEFBQVksQUFBNkIsQUFDekM7YUFBQSxBQUFLLFFBQVEsS0FBQSxBQUFLLFVBQUwsQUFBZSxpQkFBNUIsQUFBYSxBQUFnQyxBQUM3QzthQUFBLEFBQUssUUFBUSxLQUFBLEFBQUssVUFBTCxBQUFlLGNBQTVCLEFBQWEsQUFBNkIsQUFDMUM7YUFBQSxBQUFLLFFBQVEsS0FBQSxBQUFLLFVBQUwsQUFBZSxjQUE1QixBQUFhLEFBQTZCLEFBQzFDO2FBQUEsQUFBSyxXQUFXLEtBQUEsQUFBSyxNQUFMLEFBQVcsY0FBM0IsQUFBZ0IsQUFBeUIsQUFFekM7O2FBQUEsQUFBSyxhQUFhLEtBQUEsQUFBSyxVQUFMLEFBQWUsY0FBakMsQUFBa0IsQUFBNkIsQUFDL0M7YUFBQSxBQUFLLGlCQUFpQixLQUFBLEFBQUssVUFBTCxBQUFlLGNBQXJDLEFBQXNCLEFBQTZCLEFBRW5EOzthQUFBLEFBQUssVUFBVSxLQUFBLEFBQUssVUFBTCxBQUFlLGNBQTlCLEFBQWUsQUFBNkIsQUFDNUM7YUFBQSxBQUFLLGVBQWUsS0FBQSxBQUFLLFFBQUwsQUFBYSxjQUFqQyxBQUFvQixBQUEyQixBQUUvQzs7Z0JBQUEsQUFBUSxJQUFJLEtBQVosQUFBaUIsQUFFakI7O0FBQ0E7YUFBQSxBQUFLLFdBQVcsS0FBQSxBQUFLLG1CQUFtQixLQUF4QyxBQUFnQixBQUE2QixBQUM3QzthQUFBLEFBQUssV0FBVyxLQUFBLEFBQUssaUJBQWlCLEtBQXRDLEFBQWdCLEFBQTJCLEFBQzNDO2FBQUEsQUFBSyxrQkFB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QUFNLEtBQUEsQUFBSyxTQUFMLEFBQWMsSUFBekIsQUFBNkIsT0FBN0MsQUFBb0QsTUFBekcsQUFBK0csQUFDL0c7aUJBQUEsQUFBSyxXQUFMLEFBQWdCLE1BQWhCLEFBQXNCLFlBQVksZ0JBQWdCLEtBQUEsQUFBSyxTQUFyQixBQUE4QixJQUFoRSxBQUFvRSxBQUNwRTtpQkFBQSxBQUFLLFdBQUwsQUFBZ0IsTUFBaEIsQUFBc0IsZUFBZSxLQUFBLEFBQUssU0FBTCxBQUFjLElBQW5ELEFBQXVELEFBRTFEO0FBR0Q7Ozs7Ozs7Ozs7OzswQ0FPa0IsT0FBTyxBQUNyQjtpQkFBQSxBQUFLLGNBQWMsU0FBUyxNQUFBLEFBQU0sY0FBTixBQUFvQixhQUFoRCxBQUFtQixBQUFTLEFBQWlDLEFBQ2hFO0FBR0Q7Ozs7Ozs7Ozs7OztxQ0FPYSxPQUFPLEFBRWhCOztrQkFBQSxBQUFNLEFBRU47O2dCQUFHLE1BQUEsQUFBTSxTQUFTLEtBQWxCLEFBQXVCLGdCQUFnQixLQUFBLEFBQUssY0FBYyxLQUFBLEFBQUssY0FBL0QsQUFBdUMsQUFBc0MsUUFDcEUsSUFBRyxNQUFBLEFBQU0sU0FBUyxDQUFDLEtBQW5CLEFBQXdCLGdCQUFnQixLQUFBLEFBQUssY0FBYyxLQUFBLEFBQUssY0FBeEIsQUFBc0MsQUFFMUY7QUFHRDs7Ozs7Ozs7Ozs7O29DQU9ZLE9BQU8sQUFFZjs7aUJBQUEsQUFBSzttQkFDRSxDQUFDLE1BQU0sTUFBQSxBQUFNLFVBQVUsT0FBdkIsQUFBOEIsY0FEckIsQUFDbUMsQUFDL0M7bUJBQUcsQ0FBQyxNQUFNLE1BQUEsQUFBTSxVQUFVLE9BQXZCLEFBQThCLGVBRnJDLEFBQWdCLEFBRW9DLEFBR3BEO0FBTGdCLEFBQ1o7O2lCQUlKLEFBQUssQUFFUjs7Ozs7OztrQkF0UGdCIiwiZmlsZSI6IldvcmtJdGVtcy5qcyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogV29yayBJdGVtc1xuICovXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBXb3JrSXRlbXMge1xuXG5cbiAgICAvKipcbiAgICAgKiBAY29uc3RydWN0b3JcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3RvcigpIHtcblxuICAgICAgICAvLyBFbGVtZW50c1xuICAgICAgICB0aGlzLmNvbnRhaW5lciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLXdvcms9XCJjb250YWluZXJcIl0nKTtcbiAgICAgICAgdGhpcy5saXN0ID0gdGhpcy5jb250YWluZXIucXVlcnlTZWxlY3RvcignW2RhdGEtd29yaz1cIml0ZW1zXCJdJyk7XG4gICAgICAgIHRoaXMuaXRlbXMgPSB0aGlzLmNvbnRhaW5lci5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS13b3JrPVwiaXRlbVwiXScpO1xuICAgICAgICB0aGlzLm1lZGlhID0gdGhpcy5jb250YWluZXIucXVlcnlTZWxlY3RvcignW2RhdGEtd29yaz1cIm1lZGlhXCJdJyk7XG4gICAgICAgIHRoaXMudmlkZW8gPSB0aGlzLmNvbnRhaW5lci5xdWVyeVNlbGVjdG9yKCdbZGF0YS13b3JrPVwidmlkZW9cIl0nKTtcbiAgICAgICAgdGhpcy52aWRlb1NyYyA9IHRoaXMudmlkZW8ucXVlcnlTZWxlY3RvcignW2RhdGEtdmlkZW89XCJzcmNcIl0nKTtcblxuICAgICAgICB0aGlzLnBhZ2luYXRpb24gPSB0aGlzLmNvbnRhaW5lci5xdWVyeVNlbGVjdG9yKCdbZGF0YS13b3JrPVwicGFnaW5hdGlvblwiXScpO1xuICAgICAgICB0aGlzLnBhZ2luYXRpb25MaXN0ID0gdGhpcy5jb250YWluZXIucXVlcnlTZWxlY3RvcignW2RhdGEtcGFnaW5hdGlvbj1cImxpc3RcIl0nKTtcblxuICAgICAgICB0aGlzLmFjY2VudHMgPSB0aGlzLmNvbnRhaW5lci5xdWVyeVNlbGVjdG9yKCdbZGF0YS13b3JrPVwiYWNjZW50c1wiXScpO1xuICAgICAgICB0aGlzLnByb2plY3RDb3VudCA9IHRoaXMuYWNjZW50cy5xdWVyeVNlbGVjdG9yKCdbZGF0YS1hY2NlbnQ9XCJwcm9qZWN0XCJdJyk7XG5cbiAgICAgICAgY29uc29sZS5sb2codGhpcy5hY2NlbnRzKTtcblxuICAgICAgICAvLyBHZW5lcmF0ZSBJdGVtc1xuICAgICAgICB0aGlzLml0ZW1zQXJyID0gdGhpcy5nZW5lcmF0ZUl0ZW1zQXJyYXkodGhpcy5pdGVtcyk7XG4gICAgICAgIHRoaXMuaXRlbXNNYXAgPSB0aGlzLmdlbmVyYXRlSXRlbXNNYXAodGhpcy5pdGVtcyk7XG4gICAgICAgIHRoaXMucGFnaW5hdGlvbkl0ZW1zID0gdGhpcy5nZW5lcmF0ZVBhZ2luYXRpb25JdGVtcyh0aGlzLml0ZW1zLmxlbmd0aCk7XG5cbiAgICAgICAgLy8gSXRlbSBWYWx1ZXNcbiAgICAgICAgdGhpcy5jdXJyZW50SXRlbSA9IDA7XG4gICAgICAgIHRoaXMucHJldkl0ZW0gPSB0aGlzLmN1cnJlbnRJdGVtO1xuXG4gICAgICAgIHRoaXMuaXNBbmltYXRpbmcgPSBmYWxzZTtcblxuICAgICAgICB0aGlzLm1vdXNlUG9zID0ge307XG4gICAgICAgIHRoaXMubW91c2VUaHJlc2hvbGQgPSAxNTA7XG5cbiAgICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ21vdXNlbW92ZScsIHRoaXMub25Nb3VzZU1vdmUuYmluZCh0aGlzKSk7XG4gICAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdtb3VzZXdoZWVsJywgdGhpcy5vbk1vdXNlV2hlZWwuYmluZCh0aGlzKSk7XG5cbiAgICAgICAgLy8gSW5pdGlhbGl6ZSBhcHBsaWNhdGlvblxuICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHRoaXMuaW5pdCgpLCA1MDApO1xuXG4gICAgfVxuXG5cbiAgICAvKipcbiAgICAgKiBJbml0aWFsaXplIHRoZSBhY3RpdmUgaXRlbS5cbiAgICAgKlxuICAgICAqIEBtZXRob2RcbiAgICAgKiBAcmV0dXJucyB2b2lkXG4gICAgICovXG4gICAgaW5pdCgpIHtcblxuICAgICAgICB0aGlzLmNvbnRhaW5lci5jbGFzc0xpc3QucmVtb3ZlKCd0cmFuc2l0aW9uaW5nJyk7XG4gICAgICAgIHRoaXMucGFnaW5hdGlvbi5jbGFzc0xpc3QucmVtb3ZlKCdsb2FkaW5nJyk7XG4gICAgICAgIHRoaXMuc2V0QWN0aXZlSXRlbSgwKTtcblxuICAgIH1cblxuXG4gICAgLyoqXG4gICAgICogU2V0IHRoIGFjdGl2ZSBpdGVtIGluIHRoZSBsaXN0XG4gICAgICpcbiAgICAgKiBAbWV0aG9kXG4gICAgICogQHBhcmFtIHtOdW1iZXJ9IGluZGV4XG4gICAgICogQHJldHVybnMgdm9pZFxuICAgICAqL1xuICAgIHNldEFjdGl2ZUl0ZW0oaW5kZXgpIHtcblxuICAgICAgICBpZighdGhpcy5pc0FuaW1hdGluZyAmJiBpbmRleCA+PSAwICYmIGluZGV4IDw9IHRoaXMuaXRlbXNBcnIubGVuZ3RoIC0gMSkge1xuXG4gICAgICAgICAgICB0aGlzLmlzQW5pbWF0aW5nID0gdHJ1ZTtcblxuICAgICAgICAgICAgdGhpcy5wcmV2SXRlbSA9IHRoaXMuY3VycmVudEl0ZW07XG4gICAgICAgICAgICB0aGlzLmN1cnJlbnRJdGVtID0gaW5kZXg7XG5cbiAgICAgICAgICAgIHRoaXMuY29udGFpbmVyLmNsYXNzTGlzdC5hZGQoJ3RyYW5zaXRpb25pbmcnKTtcbiAgICAgICAgICAgIHRoaXMuaXRlbXNNYXBbdGhpcy5wcmV2SXRlbV0uZWwuY2xhc3NMaXN0LnJlbW92ZSgnYWN0aXZlJyk7XG5cbiAgICAgICAgICAgIHRoaXMucGFnaW5hdGlvbkl0ZW1zW3RoaXMucHJldkl0ZW1dLmNsYXNzTGlzdC5yZW1vdmUoJ2FjdGl2ZScpO1xuICAgICAgICAgICAgdGhpcy5wYWdpbmF0aW9uTGlzdC5zdHlsZS50cmFuc2Zvcm0gPSAndHJhbnNsYXRlWCgtJyArIDQ2ICogdGhpcy5jdXJyZW50SXRlbSArICdweCknO1xuXG4gICAgICAgICAgICAvLyBEZWxheSB0aGUgbmV4dCBpdGVtIGFuaW1hdGlvbnMuXG4gICAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcblxuICAgICAgICAgICAgICAgIHRoaXMuaXNBbmltYXRpbmcgPSBmYWxzZTtcblxuICAgICAgICAgICAgICAgIHRoaXMudmlkZW9TcmMuc3JjID0gdGhpcy5pdGVtc01hcFt0aGlzLmN1cnJlbnRJdGVtXS5lbC5nZXRBdHRyaWJ1dGUoJ2RhdGEtbWVkaWEnKTtcblxuICAgICAgICAgICAgICAgIHRoaXMuY29udGFpbmVyLmNsYXNzTGlzdC5yZW1vdmUoJ3RyYW5zaXRpb25pbmcnKTtcbiAgICAgICAgICAgICAgICB0aGlzLml0ZW1zTWFwW3RoaXMuY3VycmVudEl0ZW1dLmVsLmNsYXNzTGlzdC5hZGQoJ2FjdGl2ZScpO1xuICAgICAgICAgICAgICAgIHRoaXMucGFnaW5hdGlvbkl0ZW1zW3RoaXMuY3VycmVudEl0ZW1dLmNsYXNzTGlzdC5hZGQoJ2FjdGl2ZScpO1xuXG4gICAgICAgICAgICAgICAgdGhpcy5wcm9qZWN0Q291bnQuaW5uZXJIVE1MID0gJzAnICsgKGluZGV4ICsgMSk7XG5cbiAgICAgICAgICAgIH0sIDE1MDApO1xuXG4gICAgICAgIH1cblxuICAgIH1cblxuXG4gICAgLyoqXG4gICAgICogR2VuZXJhdGUgYW4gYXJyYXkgZnJvbSB0aGUgd29yayBpdGVtcyBpbiB0aGUgRE9NLlxuICAgICAqXG4gICAgICpcbiAgICAgKiBAcGFyYW0ge05vZGVMaXN0fSBub2RlTGlzdFxuICAgICAqIEByZXR1cm5zIHtBcnJheX1cbiAgICAgKi9cbiAgICBnZW5lcmF0ZUl0ZW1zQXJyYXkobm9kZUxpc3QpIHtcblxuICAgICAgICBjb25zdCBpdGVtcyA9IFtdO1xuXG4gICAgICAgIG5vZGVMaXN0LmZvckVhY2goKGVsZW1lbnQsIGluZGV4KSA9PiBpdGVtcy5wdXNoKHtcbiAgICAgICAgICAgIGluZGV4OiBpbmRleCxcbiAgICAgICAgICAgIGVsOiBlbGVtZW50XG4gICAgICAgIH0pKTtcblxuICAgICAgICByZXR1cm4gaXRlbXM7XG5cbiAgICB9XG5cblxuICAgIC8qKlxuICAgICAqIEdlbmVyYXRlIGEgbWFwIG9mIHRoZSBpdGVtc1xuICAgICAqXG4gICAgICogQG1ldGhvZFxuICAgICAqIEBwYXJhbSB7Tm9kZUxpc3R9IG5vZGVMaXN0XG4gICAgICogQHJldHVybnMge09iamVjdH1cbiAgICAgKi9cbiAgICBnZW5lcmF0ZUl0ZW1zTWFwKG5vZGVMaXN0KSB7XG5cbiAgICAgICAgY29uc3QgbWFwID0ge307XG5cbiAgICAgICAgbm9kZUxpc3QuZm9yRWFjaCgoZWxlbWVudCwgaW5kZXgpID0+IHtcblxuICAgICAgICAgICAgY29uc3QgbmFtZSA9IGVsZW1lbnQuZ2V0QXR0cmlidXRlKCdkYXRhLW5hbWUnKTtcblxuICAgICAgICAgICAgbWFwW2luZGV4XSA9IHtcbiAgICAgICAgICAgICAgICBpbmRleDogaW5kZXgsXG4gICAgICAgICAgICAgICAgbmFtZTogbmFtZSxcbiAgICAgICAgICAgICAgICBlbDogZWxlbWVudFxuICAgICAgICAgICAgfTtcblxuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gbWFwO1xuXG4gICAgfVxuXG5cbiAgICAvKipcbiAgICAgKiBHZW5lcmF0ZSB0aGUgaXRlbXMgZm9yIHRoZSBwYWdpbmF0aW9uXG4gICAgICpcbiAgICAgKiBAbWV0aG9kXG4gICAgICogQHBhcmFtIHtOdW1iZXJ9IGNvdW50XG4gICAgICogQHJldHVybnMge09iamVjdH1cbiAgICAgKi9cbiAgICBnZW5lcmF0ZVBhZ2luYXRpb25JdGVtcyhjb3VudCkge1xuXG4gICAgICAgIGNvbnN0IG1hcCA9IHt9O1xuXG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgY291bnQ7IGkrKykge1xuXG4gICAgICAgICAgICBjb25zdCBpdGVtID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnbGknKTtcbiAgICAgICAgICAgIGl0ZW0uY2xhc3NMaXN0LmFkZCgnd29yay1wYWdpbmF0aW9uX19pdGVtJyk7XG4gICAgICAgICAgICBpdGVtLnNldEF0dHJpYnV0ZSgnZGF0YS1wYWdpbmF0aW9uJywgJ2l0ZW0nKTtcbiAgICAgICAgICAgIGl0ZW0uc2V0QXR0cmlidXRlKCdkYXRhLWluZGV4JywgaSk7XG4gICAgICAgICAgICBpdGVtLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgdGhpcy5vblBhZ2luYXRpb25DbGljay5iaW5kKHRoaXMpKTtcblxuICAgICAgICAgICAgaWYoaSA9PT0gMCkgaXRlbS5jbGFzc0xpc3QuYWRkKCdhY3RpdmUnKTtcblxuICAgICAgICAgICAgdGhpcy5wYWdpbmF0aW9uTGlzdC5hcHBlbmRDaGlsZChpdGVtKTtcblxuICAgICAgICAgICAgbWFwW2ldID0gaXRlbTtcblxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIG1hcDtcblxuICAgIH1cblxuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIHRoZSBtb3ZpbmcgZWxlbWVudHMgd2l0aGluIHRoZSBhcHAgYmFzZWQgb24gbW91c2UgcG9zaXRpb24uXG4gICAgICpcbiAgICAgKiBAbWV0aG9kXG4gICAgICogQHJldHVybnMgdm9pZFxuICAgICAqL1xuICAgIHVwZGF0ZU1vdmVtZW50KCkge1xuXG4gICAgICAgIHRoaXMudmlkZW8uc3R5bGUudHJhbnNmb3JtID0gJ3JvdGF0ZVgoJyArIHRoaXMubW91c2VQb3MueCArICdkZWcpIHJvdGF0ZVkoJyArIHRoaXMubW91c2VQb3MueSArICdkZWcpJztcbiAgICAgICAgdGhpcy5pdGVtc01hcFt0aGlzLmN1cnJlbnRJdGVtXS5lbC5zdHlsZS50cmFuc2Zvcm0gPSAndHJhbnNsYXRlWCgnICsgTWF0aC5yb3VuZCh0aGlzLm1vdXNlUG9zLnkgKiAxMDApIC8gMTAwICsgJyUpIHRyYW5zbGF0ZVkoLTUwJSknO1xuICAgICAgICB0aGlzLnBhZ2luYXRpb24uc3R5bGUudHJhbnNmb3JtID0gJ3RyYW5zbGF0ZVgoJyArIHRoaXMubW91c2VQb3MueSArICclKSc7XG4gICAgICAgIHRoaXMucGFnaW5hdGlvbi5zdHlsZS5tYXJnaW5Cb3R0b20gPSB0aGlzLm1vdXNlUG9zLnggKyAncHgnO1xuXG4gICAgfVxuXG5cbiAgICAvKipcbiAgICAgKiBPbiBwYWdpbmF0aW9uIGl0ZW0gY2xpY2ssIGNoYW5nZSBpdGVtLlxuICAgICAqXG4gICAgICogQG1ldGhvZFxuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBldmVudFxuICAgICAqIEByZXR1cm5zIHZvaWRcbiAgICAgKi9cbiAgICBvblBhZ2luYXRpb25DbGljayhldmVudCkge1xuICAgICAgICB0aGlzLnNldEFjdGl2ZUl0ZW0ocGFyc2VJbnQoZXZlbnQuY3VycmVudFRhcmdldC5nZXRBdHRyaWJ1dGUoJ2RhdGEtaW5kZXgnKSkpO1xuICAgIH1cblxuXG4gICAgLyoqXG4gICAgICogT24gc2Nyb2xsLCBjaGFuZ2UgaXRlbS5cbiAgICAgKlxuICAgICAqIEBtZXRob2RcbiAgICAgKiBAcGFyYW0ge09iamVjdH0gZXZlbnRcbiAgICAgKiBAcmV0dXJucyB2b2lkXG4gICAgICovXG4gICAgb25Nb3VzZVdoZWVsKGV2ZW50KSB7XG5cbiAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcblxuICAgICAgICBpZihldmVudC5kZWx0YVkgPiB0aGlzLm1vdXNlVGhyZXNob2xkKSB0aGlzLnNldEFjdGl2ZUl0ZW0odGhpcy5jdXJyZW50SXRlbSArIDEpO1xuICAgICAgICAgICAgZWxzZSBpZihldmVudC5kZWx0YVkgPCAtdGhpcy5tb3VzZVRocmVzaG9sZCkgdGhpcy5zZXRBY3RpdmVJdGVtKHRoaXMuY3VycmVudEl0ZW0gLSAxKTtcblxuICAgIH1cblxuXG4gICAgLyoqXG4gICAgICogT24gbW91c2UgbW92ZSwgc2V0IG91ciBYIGFuZCBZXG4gICAgICpcbiAgICAgKiBAbWV0aG9kXG4gICAgICogQHBhcmFtIHtPYmplY3R9IGV2ZW50XG4gICAgICogQHJldHVybnMgdm9pZFxuICAgICAqL1xuICAgIG9uTW91c2VNb3ZlKGV2ZW50KSB7XG5cbiAgICAgICAgdGhpcy5tb3VzZVBvcyA9IHtcbiAgICAgICAgICAgIHk6ICgwLjUgLSBldmVudC5zY3JlZW5YIC8gd2luZG93LmlubmVyV2lkdGgpICogNSxcbiAgICAgICAgICAgIHg6ICgwLjUgLSBldmVudC5zY3JlZW5ZIC8gd2luZG93LmlubmVySGVpZ2h0KSAqIDVcbiAgICAgICAgfTtcblxuICAgICAgICB0aGlzLnVwZGF0ZU1vdmVtZW50KCk7XG5cbiAgICB9XG5cbn1cbiJdfQ=="
    }
  ],
  "/Users/liam/Sites/Personal/portfolio/application/scripts/entry.js": [
    "'use strict';\n\nvar _WorkItems = require('./components/WorkItems');\n\nvar _WorkItems2 = _interopRequireDefault(_WorkItems);\n\nfunction _interopRequireDefault(obj) {\n    return obj && obj.__esModule ? obj : { default: obj };\n}\n\n// NodeList Polyfill for forEach\nif (window.NodeList && !NodeList.prototype.forEach) {\n    NodeList.prototype.forEach = function (callback, thisArg) {\n        thisArg = thisArg || window;\n        for (var i = 0; i < this.length; i++) {\n            callback.call(thisArg, this[i], i, this);\n        }\n    };\n}\n\n/**\n * Entry point\n */\n// Components\nwindow.onload = function () {\n\n    new _WorkItems2.default();\n};\n",
    {
      "./components/WorkItems": "/Users/liam/Sites/Personal/portfolio/application/scripts/components/WorkItems.js"
    },
    {
      "id": "/Users/liam/Sites/Personal/portfolio/application/scripts/entry.js",
      "hash": "HI7InQ",
      "browserifyId": "/Users/liam/Sites/Personal/portfolio/application/scripts/entry.js",
      "sourcemap": "//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImVudHJ5LmpzP3ZlcnNpb249SEk3SW5RIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUNBOzs7Ozs7OztBQUdBO0FBQ0EsSUFBSSxPQUFBLEFBQU8sWUFBWSxDQUFDLFNBQUEsQUFBUyxVQUFqQyxBQUEyQyxTQUFTLEFBQ2hEO2FBQUEsQUFBUyxVQUFULEFBQW1CLFVBQVUsVUFBQSxBQUFVLFVBQVYsQUFBb0IsU0FBUyxBQUN0RDtrQkFBVSxXQUFWLEFBQXFCLEFBQ3JCO2FBQUssSUFBSSxJQUFULEFBQWEsR0FBRyxJQUFJLEtBQXBCLEFBQXlCLFFBQXpCLEFBQWlDLEtBQUssQUFDbEM7cUJBQUEsQUFBUyxLQUFULEFBQWMsU0FBUyxLQUF2QixBQUF1QixBQUFLLElBQTVCLEFBQWdDLEdBQWhDLEFBQW1DLEFBQ3RDO0FBQ0o7QUFMRCxBQU1IOzs7QUFFRDs7O0FBZEE7QUFpQkEsT0FBQSxBQUFPLFNBQVMsWUFBTSxBQUVsQjs7b0JBRUg7QUFKRCIsImZpbGUiOiJlbnRyeS5qcyIsInNvdXJjZXNDb250ZW50IjpbIi8vIENvbXBvbmVudHNcbmltcG9ydCBXb3JrSXRlbXMgZnJvbSAnLi9jb21wb25lbnRzL1dvcmtJdGVtcyc7XG5cblxuLy8gTm9kZUxpc3QgUG9seWZpbGwgZm9yIGZvckVhY2hcbmlmICh3aW5kb3cuTm9kZUxpc3QgJiYgIU5vZGVMaXN0LnByb3RvdHlwZS5mb3JFYWNoKSB7XG4gICAgTm9kZUxpc3QucHJvdG90eXBlLmZvckVhY2ggPSBmdW5jdGlvbiAoY2FsbGJhY2ssIHRoaXNBcmcpIHtcbiAgICAgICAgdGhpc0FyZyA9IHRoaXNBcmcgfHwgd2luZG93O1xuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IHRoaXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICAgIGNhbGxiYWNrLmNhbGwodGhpc0FyZywgdGhpc1tpXSwgaSwgdGhpcyk7XG4gICAgICAgIH1cbiAgICB9O1xufVxuXG4vKipcbiAqIEVudHJ5IHBvaW50XG4gKi9cbndpbmRvdy5vbmxvYWQgPSAoKSA9PiB7XG5cbiAgICBuZXcgV29ya0l0ZW1zKCk7XG5cbn07XG4iXX0="
    }
  ]
}, [
  "/Users/liam/Sites/Personal/portfolio/application/scripts/entry.js"
], {
  "nodeModulesRoot": "/Users/liam/Sites/Personal/portfolio/node_modules",
  "port": 4474,
  "host": null,
  "clientEnabled": true,
  "debug": false,
  "babel": true
});
//# sourceMappingURL=bundle.js.map
