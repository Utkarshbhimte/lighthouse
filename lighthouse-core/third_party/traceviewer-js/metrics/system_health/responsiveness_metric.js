/**
Copyright (c) 2015 The Chromium Authors. All rights reserved.
Use of this source code is governed by a BSD-style license that can be
found in the LICENSE file.
**/

require("../../base/statistics.js");
require("../metric_registry.js");
require("./utils.js");
require("../../model/user_model/animation_expectation.js");
require("../../model/user_model/load_expectation.js");
require("../../model/user_model/response_expectation.js");
require("../../value/numeric.js");
require("../../value/value.js");

'use strict';

global.tr.exportTo('tr.metrics.sh', function() {
  // In the case of Response, Load, and DiscreteAnimation IRs, Responsiveness is
  // derived from the time between when the user thinks they begin an interation
  // (expectedStart) and the time when the screen first changes to reflect the
  // interaction (actualEnd).  There may be a delay between expectedStart and
  // when chrome first starts processing the interaction (actualStart) if the
  // main thread is busy.  The user doesn't know when actualStart is, they only
  // know when expectedStart is. User responsiveness, by definition, considers
  // only what the user experiences, so "duration" is defined as actualEnd -
  // expectedStart.

  // This histogram represents the number of people who we believe would
  // score the responsiveness at a certain value. We have set this with
  // just a best-effort guess, though. In #1696, we plan to derive this
  // experimentally.
  var RESPONSE_HISTOGRAM = tr.v.Numeric.fromDict({
    unit: 'unitless',
    min: 150,
    max: 5000,
    centralBinWidth: 485,
    underflowBin: {min: -Number.MAX_VALUE, max: 150, count: 1000},
    centralBins: [
      {min: 150, max: 635, count: 708},
      {min: 635, max: 1120, count: 223},
      {min: 1120, max: 1605, count: 50},
      {min: 1605, max: 2090, count: 33},
      {min: 2090, max: 2575, count: 23},
      {min: 2575, max: 3060, count: 17},
      {min: 3060, max: 3545, count: 12},
      {min: 3545, max: 4030, count: 8},
      {min: 4030, max: 4515, count: 4},
      {min: 4515, max: 5000, count: 1}
    ],
    overflowBin: {min: 5000, max: Number.MAX_VALUE, count: 0}
  });

  var FAST_RESPONSE_HISTOGRAM = tr.v.Numeric.fromDict({
    unit: 'unitless',
    min: 66,
    max: 2200,
    centralBinWidth: 214,
    underflowBin: {min: -Number.MAX_VALUE, max: 66, count: 1000},
    centralBins: [
      {min: 66, max: 280, count: 708},
      {min: 280, max: 493, count: 223},
      {min: 493, max: 706, count: 50},
      {min: 706, max: 920, count: 33},
      {min: 920, max: 1133, count: 23},
      {min: 1133, max: 1346, count: 17},
      {min: 1346, max: 1560, count: 12},
      {min: 1560, max: 1773, count: 8},
      {min: 1773, max: 1987, count: 4},
      {min: 1987, max: 2200, count: 1}
    ],
    overflowBin: {min: 2200, max: Number.MAX_VALUE, count: 0}
  });

  var LOAD_HISTOGRAM = tr.v.Numeric.fromDict({
    unit: 'unitless',
    min: 1000,
    max: 60000,
    centralBinWidth: 5900,
    underflowBin: {min: -Number.MAX_VALUE, max: 1000, count: 1000},
    centralBins: [
      {min: 1000, max: 6900, count: 901},
      {min: 6900, max: 12800, count: 574},
      {min: 12800, max: 18700, count: 298},
      {min: 18700, max: 24600, count: 65},
      {min: 24600, max: 30500, count: 35},
      {min: 30500, max: 36400, count: 23},
      {min: 36400, max: 42300, count: 16},
      {min: 42300, max: 48200, count: 10},
      {min: 48200, max: 54100, count: 5},
      {min: 54100, max: 60000, count: 2}
    ],
    overflowBin: {min: 60000, max: Number.MAX_VALUE, count: 0}
  });

  var UNIT = tr.v.Unit.byName.normalizedPercentage_biggerIsBetter;


  function computeDurationResponsiveness(histogram, duration) {
    return histogram.getInterpolatedCountAt(duration) / histogram.maxCount;
  }

  function groupingKeysForUserExpectation(ue) {
    // Value doesn't make a copy of its options or groupingKeys. One Value's
    // groupingKeys cannot be shared with another Value.
    var groupingKeys = {};
    groupingKeys.userExpectationStableId = ue.stableId;
    groupingKeys.userExpectationStageTitle = ue.stageTitle;
    groupingKeys.userExpectationInitiatorTitle = ue.initiatorTitle;
    return groupingKeys;
  }

  // The Animation Throughput score is maximized at this value of average
  // frames-per-second.
  var MAX_FPS = 60;

  // The Animation Throughput score is minimized at this value of average
  // frames-per-second.
  var MIN_FPS = 10;

  function computeAnimationThroughput(animationExpectation) {
    if (animationExpectation.frameEvents === undefined ||
        animationExpectation.frameEvents.length === 0)
      throw new Error('Animation missing frameEvents ' +
                      animationExpectation.stableId);

    var durationSeconds = animationExpectation.duration / 1000;
    var avgSpf = durationSeconds / animationExpectation.frameEvents.length;
    var throughput = 1 - tr.b.normalize(avgSpf, 1 / MAX_FPS, 1 / MIN_FPS);
    return tr.b.clamp(throughput, 0, 1);
  }

  // The smoothness score is maximized when frame timestamp discrepancy is
  // less than or equal to this:
  var MIN_DISCREPANCY = 0.05;

  // The smoothness score is minimized when frame timestamp discrepancy is
  // greater than or equal to this:
  var MAX_DISCREPANCY = 0.3;

  function computeAnimationSmoothness(animationExpectation) {
    if (animationExpectation.frameEvents === undefined ||
        animationExpectation.frameEvents.length === 0)
      throw new Error('Animation missing frameEvents ' +
                      animationExpectation.stableId);

    var frameTimestamps = animationExpectation.frameEvents;
    frameTimestamps = frameTimestamps.toArray().map(function(event) {
      return event.start;
    });

    var absolute = false;
    var discrepancy = tr.b.Statistics.timestampsDiscrepancy(
        frameTimestamps, absolute);
    var smoothness = 1 - tr.b.normalize(
        discrepancy, MIN_DISCREPANCY, MAX_DISCREPANCY);
    return tr.b.clamp(smoothness, 0, 1);
  }

  function computeAnimationResponsiveness(
      animationExpectation, diagnosticValues) {
    var throughput = computeAnimationThroughput(animationExpectation);
    if (throughput === undefined)
      throw new Error('Missing throughput for ' +
                      animationExpectation.stableId);

    var options = {};
    options.description = 'Mean Opinion Score for Animation throughput';

    diagnosticValues.addValue(new tr.v.NumericValue(
        animationExpectation.parentModel.canonicalUrl, 'throughput',
        new tr.v.ScalarNumeric(UNIT, throughput),
        options, groupingKeysForUserExpectation(animationExpectation)));

    var smoothness = computeAnimationSmoothness(animationExpectation);
    if (smoothness === undefined)
      throw new Error('Missing smoothness for ' +
                      animationExpectation.stableId);

    options = {};
    options.description = 'Mean Opinion Score for Animation smoothness';

    diagnosticValues.addValue(new tr.v.NumericValue(
        animationExpectation.parentModel.canonicalUrl, 'smoothness',
        new tr.v.ScalarNumeric(UNIT, smoothness),
        options, groupingKeysForUserExpectation(animationExpectation)));

    return tr.b.Statistics.weightedMean(
        [throughput, smoothness], tr.metrics.sh.perceptualBlend);
  }

  function computeResponsiveness(ue, diagnosticValues) {
    var score = undefined;

    var options = {};

    if (ue instanceof tr.model.um.IdleExpectation) {
      throw new Error('Responsiveness is not defined for Idle');
    } else if (ue instanceof tr.model.um.LoadExpectation) {
      score = computeDurationResponsiveness(LOAD_HISTOGRAM, ue.duration);
      options.description =
          'Mean Opinion Score of Time to First ContentfulPaint';
    } else if (ue instanceof tr.model.um.ResponseExpectation) {
      var histogram = RESPONSE_HISTOGRAM;
      if (ue.isAnimationBegin)
        histogram = FAST_RESPONSE_HISTOGRAM;

      score = computeDurationResponsiveness(histogram, ue.duration);
      options.description = 'Mean Opinion Score of input latency';
    } else if (ue instanceof tr.model.um.AnimationExpectation) {
      score = computeAnimationResponsiveness(ue, diagnosticValues);
      options.description =
          'Mean Opinion Score of perceptual blend of throughput and smoothness';
    } else {
      throw new Error('Unrecognized stage for ' + ue.stableId);
    }

    if (score === undefined)
      throw new Error('Unable to compute responsiveness for ' + ue.stableId);

    diagnosticValues.addValue(new tr.v.NumericValue(
        ue.parentModel.canonicalUrl, 'responsiveness',
        new tr.v.ScalarNumeric(UNIT, score),
        options, groupingKeysForUserExpectation(ue)));

    return score;
  }

  function responsivenessMetric(valueList, model) {
    var scores = [];
    var diagnosticValues = new tr.metrics.ValueList();

    model.userModel.expectations.forEach(function(ue) {
      // Responsiveness is not defined for Idle.
      if (ue instanceof tr.model.um.IdleExpectation)
        return;

      scores.push(computeResponsiveness(ue, diagnosticValues));
    });

    var options = {};
    options.description =
      'Perceptual blend of responsiveness of RAIL user expectations';
    var groupingKeys = {};
    var overallScore = tr.b.Statistics.weightedMean(
        scores, tr.metrics.sh.perceptualBlend);

    if (overallScore === undefined)
      return;

    var diagnostics = {values: diagnosticValues.valueDicts};

    valueList.addValue(new tr.v.NumericValue(
        model.canonicalUrl, 'responsiveness',
        new tr.v.ScalarNumeric(UNIT, overallScore),
        options, groupingKeys, diagnostics));
  }

  responsivenessMetric.prototype = {
    __proto__: Function.prototype
  };

  tr.metrics.MetricRegistry.register(responsivenessMetric);

  return {
    responsivenessMetric: responsivenessMetric,
    computeDurationResponsiveness: computeDurationResponsiveness,
    FAST_RESPONSE_HISTOGRAM: FAST_RESPONSE_HISTOGRAM
  };
});
