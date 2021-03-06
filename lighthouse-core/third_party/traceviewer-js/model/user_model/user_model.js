/**
Copyright (c) 2016 The Chromium Authors. All rights reserved.
Use of this source code is governed by a BSD-style license that can be
found in the LICENSE file.
**/

require("../event_container.js");

'use strict';

global.tr.exportTo('tr.model.um', function() {
  function UserModel(parentModel) {
    tr.model.EventContainer.call(this);
    this.parentModel_ = parentModel;
    this.expectations_ = new tr.model.EventSet();
  }

  UserModel.prototype = {
    __proto__: tr.model.EventContainer.prototype,

    get stableId() {
      return 'UserModel';
    },

    get parentModel() {
      return this.parentModel_;
    },

    sortExpectations: function() {
      Array.prototype.sort.call(this.expectations_, function(x, y) {
        return x.start - y.start;
      });
    },

    get expectations() {
      return this.expectations_;
    },

    shiftTimestampsForward: function(amount) {
    },

    addCategoriesToDict: function(categoriesDict) {
    },

    findTopmostSlicesInThisContainer: function(eventPredicate, callback,
                                               opt_this) {
    },

    iterateAllEventsInThisContainer: function(eventTypePredicate,
                                              callback, opt_this) {
      if (eventTypePredicate.call(opt_this, tr.model.um.UserExpectation))
        this.expectations.forEach(callback, opt_this);
    },

    iterateAllChildEventContainers: function(callback, opt_this) {
    },

    updateBounds: function() {
      this.bounds.reset();
      this.expectations.forEach(function(expectation) {
        expectation.addBoundsToRange(this.bounds);
      }, this);
    }
  };

  return {
    UserModel: UserModel
  };
});
