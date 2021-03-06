/**
Copyright 2016 The Chromium Authors. All rights reserved.
Use of this source code is governed by a BSD-style license that can be
found in the LICENSE file.
**/

require("../../base/iteration_helpers.js");
require("../../base/range.js");
require("../metric_registry.js");
require("../../model/container_memory_dump.js");
require("../../model/helpers/chrome_model_helper.js");
require("../../model/memory_allocator_dump.js");
require("../../value/numeric.js");
require("../../value/unit.js");
require("../../value/value.js");

'use strict';

global.tr.exportTo('tr.metrics.sh', function() {

  var DISPLAYED_SIZE_NUMERIC_NAME =
      tr.model.MemoryAllocatorDump.DISPLAYED_SIZE_NUMERIC_NAME;
  var LIGHT = tr.model.ContainerMemoryDump.LevelOfDetail.LIGHT;
  var DETAILED = tr.model.ContainerMemoryDump.LevelOfDetail.DETAILED;
  var ScalarNumeric = tr.v.ScalarNumeric;
  var sizeInBytes_smallerIsBetter =
      tr.v.Unit.byName.sizeInBytes_smallerIsBetter;
  var unitlessNumber_smallerIsBetter =
      tr.v.Unit.byName.unitlessNumber_smallerIsBetter;

  var MMAPS_METRICS = {
    'overall:pss': {
      path: [],
      byteStat: 'proportionalResident'
    },
    'overall:private_dirty': {
      path: [],
      byteStat: 'privateDirtyResident'
    },
    'java_heap:private_dirty': {
      path: ['Android', 'Java runtime', 'Spaces'],
      byteStat: 'privateDirtyResident'
    },
    'ashmem:pss': {
      path: ['Android', 'Ashmem'],
      byteStat: 'proportionalResident'
    },
    'native_heap:pss': {
      path: ['Native heap'],
      byteStat: 'proportionalResident'
    }
  };

  var ALL_PROCESS_NAMES = 'all';

  var LEVEL_OF_DETAIL_NAMES = new Map();
  LEVEL_OF_DETAIL_NAMES.set(LIGHT, 'light');
  LEVEL_OF_DETAIL_NAMES.set(DETAILED, 'detailed');

  var MEMORY_NUMERIC_BUILDER_MAP = new WeakMap();
  // For unitless numerics (process counts), we use 20 linearly scaled bins
  // from 0 to 20.
  MEMORY_NUMERIC_BUILDER_MAP.set(unitlessNumber_smallerIsBetter,
      tr.v.NumericBuilder.createLinear(
          tr.v.Unit.byName.unitlessNumber_smallerIsBetter,
          tr.b.Range.fromExplicitRange(0, 20), 20));
  // For size numerics (subsystem and vm stats), we use 1 bin from 0 B to
  // 1 KiB and 4*24 exponentially scaled bins from 1 KiB to 16 GiB (=2^24 KiB).
  MEMORY_NUMERIC_BUILDER_MAP.set(sizeInBytes_smallerIsBetter,
      new tr.v.NumericBuilder(sizeInBytes_smallerIsBetter, 0)
          .addBinBoundary(1024 /* 1 KiB */)
          .addExponentialBins(16 * 1024 * 1024 * 1024 /* 16 GiB */, 4 * 24));

  function memoryMetric(valueList, model) {
    var browserNameToGlobalDumps = splitGlobalDumpsByBrowserName(model);
    addGeneralMemoryDumpValues(browserNameToGlobalDumps, valueList, model);
    addDetailedMemoryDumpValues(browserNameToGlobalDumps, valueList, model);
    addMemoryDumpCountValues(browserNameToGlobalDumps, valueList, model);
  }

  memoryMetric.prototype = {
    __proto__: Function.prototype
  };

  /**
   * Splits the global memory dumps in |model| by browser name.
   *
   * @param {!tr.Model} model The trace model from which the global dumps
   *     should be extracted.
   * @return {!Map<string, !Array<!tr.model.GlobalMemoryDump>} A map from
   *     browser names to the associated global memory dumps.
   */
  function splitGlobalDumpsByBrowserName(model) {
    var chromeModelHelper =
        model.getOrCreateHelper(tr.model.helpers.ChromeModelHelper);
    var browserNameToGlobalDumps = new Map();
    var globalDumpToBrowserHelper = new WeakMap();

    // 1. For each browser process in the model, add its global memory dumps to
    // |browserNameToGlobalDumps|. |chromeModelHelper| can be undefined if
    // it fails to find any browser, renderer or GPU process (see
    // tr.model.helpers.ChromeModelHelper.supportsModel).
    if (chromeModelHelper) {
      chromeModelHelper.browserHelpers.forEach(function(helper) {
        // Retrieve the associated global memory dumps and check that they
        // haven't been classified as belonging to another browser process.
        var globalDumps = helper.process.memoryDumps.map(
            d => d.globalMemoryDump);
        globalDumps.forEach(function(globalDump) {
          var existingHelper = globalDumpToBrowserHelper.get(globalDump);
          if (existingHelper !== undefined) {
            throw new Error('Memory dump ID clash across multiple browsers ' +
                'with PIDs: ' + existingHelper.pid + ' and ' + helper.pid);
          }
          globalDumpToBrowserHelper.set(globalDump, helper);
        });

        makeKeyUniqueAndSet(
            browserNameToGlobalDumps, helper.browserName, globalDumps);
      });
    }

    // 2. If any global memory dump does not have any associated browser
    // process for some reason, associate it with an 'unknown' browser so that
    // we don't lose the data.
    var unclassifiedGlobalDumps =
        model.globalMemoryDumps.filter(g => !globalDumpToBrowserHelper.has(g));
    if (unclassifiedGlobalDumps.length > 0) {
      makeKeyUniqueAndSet(
          browserNameToGlobalDumps, 'unknown', unclassifiedGlobalDumps);
    }

    return browserNameToGlobalDumps;
  }

  /**
   * Function for adding entries with duplicate keys to a map without
   * overriding existing entries.
   *
   * This is achieved by appending numeric indices (2, 3, 4, ...) to duplicate
   * keys. Example:
   *
   *   var map = new Map();
   *   // map = Map {}.
   *
   *   makeKeyUniqueAndSet(map, 'key', 'a');
   *   // map = Map {"key" => "a"}.
   *
   *   makeKeyUniqueAndSet(map, 'key', 'b');
   *   // map = Map {"key" => "a", "key2" => "b"}.
   *                                ^^^^
   *   makeKeyUniqueAndSet(map, 'key', 'c');
   *   // map = Map {"key" => "a", "key2" => "b", "key3" => "c"}.
   *                                ^^^^           ^^^^
   */
  function makeKeyUniqueAndSet(map, key, value) {
    var uniqueKey = key;
    var nextIndex = 2;
    while (map.has(uniqueKey)) {
      uniqueKey = key + nextIndex;
      nextIndex++;
    }
    map.set(uniqueKey, value);
  }

  /**
   * Add general memory dump values calculated from all global memory dumps in
   * |model| to |valueList|. In particular, this function adds the following
   * values:
   *
   *   * PROCESS COUNTS
   *     memory:{chrome, webview}:{browser, renderer, ..., all}:process_count
   *     type: tr.v.Numeric (histogram over all matching global memory dumps)
   *     unit: unitlessNumber_smallerIsBetter
   *
   *   * ALLOCATOR STATISTICS
   *     memory:{chrome, webview}:{browser, renderer, ..., all}:subsystem:
   *         {v8, malloc, ...}
   *     memory:{chrome, webview}:{browser, renderer, ..., all}:subsystem:
   *         {v8, malloc, ...}:allocated_objects
   *     memory:{chrome, webview}:{browser, renderer, ..., all}:
   *         android_memtrack:{gl, ...}
   *     type: tr.v.Numeric (histogram over all matching global memory dumps)
   *     unit: sizeInBytes_smallerIsBetter
   */
  function addGeneralMemoryDumpValues(
      browserNameToGlobalDumps, valueList, model) {
    addPerProcessNameMemoryDumpValues(browserNameToGlobalDumps,
        gmd => true /* process all global memory dumps */,
        function(processDump, addProcessScalar) {
          // Increment process_count value.
          addProcessScalar(
              'process_count',
              new ScalarNumeric(unitlessNumber_smallerIsBetter, 1));

          if (processDump.memoryAllocatorDumps === undefined)
            return;

          // Add memory:<browser-name>:<process-name>:subsystem:<name> and
          // memory:<browser-name>:<process-name>:subsystem:<name>:
          // allocated_objects values for each root memory allocator dump.
          processDump.memoryAllocatorDumps.forEach(function(rootAllocatorDump) {
            addProcessScalar(
                'subsystem:' + rootAllocatorDump.name,
                rootAllocatorDump.numerics[DISPLAYED_SIZE_NUMERIC_NAME]);
            addProcessScalar(
                'subsystem:' + rootAllocatorDump.name + ':allocated_objects',
                rootAllocatorDump.numerics['allocated_objects_size']);
          });

          // Add memory:<browser-name>:<process-name>:android_memtrack:<name>
          // value for each child of the gpu/android_memtrack memory allocator
          // dump.
          var memtrackDump = processDump.getMemoryAllocatorDumpByFullName(
              'gpu/android_memtrack');
          if (memtrackDump !== undefined) {
            memtrackDump.children.forEach(function(memtrackChildDump) {
              addProcessScalar(
                  'android_memtrack:' + memtrackChildDump.name,
                  memtrackChildDump.numerics['memtrack_pss']);
            });
          }
        }, valueList, model);
  }

  /**
   * Add heavy memory dump values calculated from heavy global memory dumps in
   * |model| to |valueList|. In particular, this function adds the following
   * values:
   *
   *   * VIRTUAL MEMORY STATISTICS
   *     memory:{chrome, webview}:{browser, renderer, ..., all}:vmstats:
   *         {overall, ashmem, native_heap}:pss
   *     memory:{chrome, webview}:{browser, renderer, ..., all}:vmstats:
   *         {overall, java_heap}:private_dirty
   *     type: tr.v.Numeric (histogram over matching heavy global memory dumps)
   *     unit: sizeInBytes_smallerIsBetter
   */
  function addDetailedMemoryDumpValues(
      browserNameToGlobalDumps, valueList, model) {
    addPerProcessNameMemoryDumpValues(browserNameToGlobalDumps,
        g => g.levelOfDetail === DETAILED,
        function(processDump, addProcessScalar) {
          // Add memory:<browser-name>:<process-name>:vmstats:<name> value for
          // each mmap metric.
          tr.b.iterItems(MMAPS_METRICS, function(metricName, metricSpec) {
            var node = getDescendantVmRegionClassificationNode(
                processDump.vmRegions, metricSpec.path);
            var value = node ? (node.byteStats[metricSpec.byteStat] || 0) : 0;
            addProcessScalar(
                'vmstats:' + metricName,
                new ScalarNumeric(sizeInBytes_smallerIsBetter, value));
          });
        }, valueList, model);
  }

  /**
   * Get the descendant of a VM region classification |node| specified by the
   * given |path| of child node titles. If |node| is undefined or such a
   * descendant does not exist, this function returns undefined.
   */
  function getDescendantVmRegionClassificationNode(node, path) {
    for (var i = 0; i < path.length; i++) {
      if (node === undefined)
        break;
      node = tr.b.findFirstInArray(node.children, c => c.title === path[i]);
    }
    return node;
  }

  /**
   * Add global memory dump counts in |model| to |valueList|. In particular,
   * this function adds the following values:
   *
   *   * DUMP COUNTS
   *     memory:{chrome, webview}:all:dump_count:{light, detailed, total}
   *     type: tr.v.ScalarNumeric (scalar over the whole trace)
   *     unit: unitlessNumber_smallerIsBetter
   *
   * Note that unlike all other values generated by the memory metric, the
   * global memory dump counts are NOT instances of tr.v.Numeric (histogram)
   * because it doesn't make sense to aggregate them (they are already counts
   * over all global dumps associated with the relevant browser).
   */
  function addMemoryDumpCountValues(
      browserNameToGlobalDumps, valueList, model) {
    browserNameToGlobalDumps.forEach(function(globalDumps, browserName) {
      var levelOfDetailNameToDumpCount = { 'total': 0 };
      LEVEL_OF_DETAIL_NAMES.forEach(function(levelOfDetailName) {
        levelOfDetailNameToDumpCount[levelOfDetailName] = 0;
      });

      globalDumps.forEach(function(globalDump) {
        // Increment the total dump count.
        levelOfDetailNameToDumpCount.total++;

        // Increment the level-of-detail-specific dump count (if possible).
        var levelOfDetailName =
            LEVEL_OF_DETAIL_NAMES.get(globalDump.levelOfDetail);
        if (!(levelOfDetailName in levelOfDetailNameToDumpCount))
          return;  // Unknown level of detail.
        levelOfDetailNameToDumpCount[levelOfDetailName]++;
      });

      // Add memory:<browser-name>:dump_count:<level> value for each level of
      // detail (and total).
      tr.b.iterItems(levelOfDetailNameToDumpCount,
          function(levelOfDetailName, levelOfDetailDumpCount) {
            valueList.addValue(new tr.v.NumericValue(
                model.canonicalUrl,
                ['memory', browserName, ALL_PROCESS_NAMES, 'dump_count',
                    levelOfDetailName].join(':'),
                new ScalarNumeric(
                    unitlessNumber_smallerIsBetter, levelOfDetailDumpCount)));
          });
    });
  }

  /**
   * Add generic values extracted from process memory dumps and aggregated by
   * browser and process name into |valueList|.
   *
   * For each browser and set of global dumps in |browserNameToGlobalDumps|,
   * |customProcessDumpValueExtractor| is applied to every process memory dump
   * associated with the global memory dump. The second argument provided to the
   * callback is a function for adding extracted values:
   *
   *   function sampleProcessDumpCallback(processDump, addProcessValue) {
   *     ...
   *     addProcessValue('value_name_1', valueExtractedFromProcessDump1);
   *     ...
   *     addProcessValue('value_name_2', valueExtractedFromProcessDump2);
   *     ...
   *   }
   *
   * For each global memory dump, the extracted values are summed by process
   * name (browser, renderer, ..., all). The sums are then aggregated over all
   * global memory dumps associated with the given browser. For example,
   * assuming that |customProcessDumpValueExtractor| extracts a value called
   * 'x' from each process memory dump, the following values will be reported:
   *
   *    memory:<browser-name>:browser:x : tr.v.Numeric aggregated over [
   *      sum of 'x' in all 'browser' process dumps in global dump 1,
   *      sum of 'x' in all 'browser' process dumps in global dump 2,
   *      ...
   *      sum of 'x' in all 'browser' process dumps in global dump N
   *    ]
   *
   *    memory:<browser-name>:renderer:x : tr.v.Numeric aggregated over [
   *      sum of 'x' in all 'renderer' process dumps in global dump 1,
   *      sum of 'x' in all 'renderer' process dumps in global dump 2,
   *      ...
   *      sum of 'x' in all 'renderer' process dumps in global dump N
   *    ]
   *
   *    ...
   *
   *    memory:<browser-name>:all:x : tr.v.Numeric aggregated over [
   *      sum of 'x' in all process dumps in global dump 1,
   *      sum of 'x' in all process dumps in global dump 2,
   *      ...
   *      sum of 'x' in all process dumps in global dump N,
   *    ]
   *
   * where global dumps 1 to N are the global dumps associated with the given
   * browser.
   *
   * @param {!Map<string, !Array<!tr.model.GlobalMemoryDump>}
   *     browserNameToGlobalDumps Map from browser names to arrays of global
   *     memory dumps. The generic values will be extracted from the associated
   *     process memory dumps.
   * @param {!function(!tr.model.GlobalMemoryDump): boolean}
   *     customGlobalDumpFilter Predicate for filtering global memory dumps.
   * @param {!function(
   *     !tr.model.ProcessMemoryDump,
   *     !function(string, !tr.v.ScalarNumeric))}
   *     customProcessDumpValueExtractor Callback for extracting values from a
   *     process memory dump.
   * @param {!tr.metrics.ValueList} valueList List of values to which the
   *     resulting aggregated values are added.
   * @param {!tr.Model} model The underlying trace model.
   */
  function addPerProcessNameMemoryDumpValues(
      browserNameToGlobalDumps, customGlobalDumpFilter,
      customProcessDumpValueExtractor, valueList, model) {
    browserNameToGlobalDumps.forEach(function(globalDumps, browserName) {
      var filteredGlobalDumps = globalDumps.filter(customGlobalDumpFilter);
      var timeToProcessNameToValueNameToScalar =
          calculatePerProcessNameMemoryDumpValues(
              filteredGlobalDumps, customProcessDumpValueExtractor);
      injectTotalsIntoPerProcessNameMemoryDumpValues(
          timeToProcessNameToValueNameToScalar);
      reportPerProcessNameMemoryDumpValues(
          timeToProcessNameToValueNameToScalar, browserName, valueList, model);
    });
  }

  /**
   * For each global memory dump in |globalDumps|, calculate per-process-name
   * sums of values extracted by |customProcessDumpValueExtractor| from the
   * associated process memory dumps.
   *
   * This function returns the following list of nested maps:
   *
   *   Global memory dump timestamp (list index)
   *     -> Process name (dict with keys 'browser', 'renderer', ...)
   *          -> Value name (dict with keys 'subsystem:v8', ...)
   *               -> Sum of value over the processes (tr.v.ScalarNumeric).
   *
   * See addPerProcessNameMemoryDumpValues for more details.
   */
  function calculatePerProcessNameMemoryDumpValues(
      globalDumps, customProcessDumpValueExtractor) {
    return globalDumps.map(function(globalDump) {
      // Process name -> Value name -> Sum over processes.
      var processNameToValueNameToScalar = {};

      tr.b.iterItems(globalDump.processMemoryDumps, function(_, processDump) {
        // Process name is typically 'browser', 'renderer', etc.
        var rawProcessName = processDump.process.name || 'unknown';
        var processName = rawProcessName.toLowerCase().replace(' ', '_');

        // Value name -> Sum over processes.
        var valueNameToScalar = processNameToValueNameToScalar[processName];
        if (valueNameToScalar === undefined)
          processNameToValueNameToScalar[processName] = valueNameToScalar = {};

        customProcessDumpValueExtractor(
            processDump,
            function addProcessScalar(name, processDumpScalar) {
              if (processDumpScalar === undefined)
                return;
              var processNameSumScalar = valueNameToScalar[name];
              if (processNameSumScalar === undefined) {
                valueNameToScalar[name] = processNameSumScalar =
                    new ScalarNumeric(
                        processDumpScalar.unit, processDumpScalar.value);
              } else {
                if (processDumpScalar.unit !== processNameSumScalar.unit) {
                  throw new Error('Multiple units provided for value \'' +
                      name + '\' of \'' + processName + '\' processes: ' +
                      processNameSumScalar.unit.unitName + ' and ' +
                      processDumpScalar.unit.unitName);
                }
                processNameSumScalar.value += processDumpScalar.value;
              }
            });
      });
      return processNameToValueNameToScalar;
    });
  }

  /**
   * For each timestamp (corresponding to a global memory dump) in
   * |timeToProcessNameToValueNameToScalar|, sum per-process-name values into
   * total values over 'all' process names.
   *
   * See addPerProcessNameMemoryDumpValues for more details.
   */
  function injectTotalsIntoPerProcessNameMemoryDumpValues(
      timeToProcessNameToValueNameToScalar) {
    timeToProcessNameToValueNameToScalar.forEach(
        function(processNameToValueNameToScalar) {
          var valueNameToProcessNameToScalar = tr.b.invertArrayOfDicts(
              tr.b.dictionaryValues(processNameToValueNameToScalar));
          processNameToValueNameToScalar[ALL_PROCESS_NAMES] = tr.b.mapItems(
              valueNameToProcessNameToScalar,
              function(valueName, perProcessScalars) {
                var unit = tr.b.findFirstInArray(perProcessScalars).unit;
                var value = perProcessScalars.reduce(
                    function(accumulator, scalar) {
                      if (scalar === undefined)
                        return accumulator;
                      if (scalar.unit !== unit) {
                        throw new Error('Multiple units provided for value \'' +
                            valueName + '\' of different processes: ' +
                            unit.unitName + ' and ' + scalar.unit.unitName);
                      }
                      return accumulator + scalar.value;
                    }, 0);
                return new ScalarNumeric(unit, value);
              });
        });
  }

  /**
   * For each process name (plus total over 'all' process names) and value
   * name, add a tr.v.Numeric aggregating the associated values across all
   * timestamps (corresponding to global memory dumps associated with the given
   * browser) in |timeToProcessNameToValueNameToScalar| to |valueList|.
   *
   * See addPerProcessNameMemoryDumpValues for more details.
   */
  function reportPerProcessNameMemoryDumpValues(
      timeToProcessNameToValueNameToScalar, browserName, valueList, model) {
    var processNameToTimeToValueNameToScalar =
        tr.b.invertArrayOfDicts(timeToProcessNameToValueNameToScalar);
    tr.b.iterItems(
        processNameToTimeToValueNameToScalar,
        function(processName, timeToValueNameToScalar) {
          var valueNameToTimeToScalar =
              tr.b.invertArrayOfDicts(timeToValueNameToScalar);
          tr.b.iterItems(
              valueNameToTimeToScalar,
              function(valueName, timeToScalar) {
                valueList.addValue(new tr.v.NumericValue(
                    model.canonicalUrl,
                    ['memory', browserName, processName, valueName].join(':'),
                    mergeScalarsIntoNumeric(timeToScalar)));
              });
        });
  }

  /**
   * Merge a list of tr.v.ScalarNumeric objects into a tr.v.Numeric (histogram).
   */
  function mergeScalarsIntoNumeric(scalars) {
    var unit = tr.b.findFirstInArray(scalars).unit;
    var numeric = MEMORY_NUMERIC_BUILDER_MAP.get(unit).build();
    for (var i = 0; i < scalars.length; i++) {
      var scalar = scalars[i];
      numeric.add(scalar === undefined ? 0 : scalar.value);
    }
    return numeric;
  }

  tr.metrics.MetricRegistry.register(memoryMetric);

  return {
    memoryMetric: memoryMetric
  };
});
