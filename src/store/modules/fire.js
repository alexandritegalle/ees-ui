// Phoenix fire
// Used to store state of fire geojson and layers
import {
  START_LOADING,
  DONE_LOADING,
  SELECT_FIRE,
  PHOENIX_ADD_SOURCE,
  PHOENIX_ADD_LAYER,
  PHOENIX_SET_OPACITY,
  PHOENIX_TIME_STEP,
  CLEAR_FIRE,
  TOGGLE_3D
} from "@/store/mutation-types";

const namespaced = true; // https://vuex.vuejs.org/guide/modules.html#namespacing

const state = {
  stepMinutes: 10,
  selectedFire: null,
  loadedLayers: [],
  loadedSources: [],
  visibleFireStep: null,
  fire3DFlameHeight: false,
  opacity: 0.4,
  fireIntensityLevels: [[0, "#ffc107"], [100000, "#dc3545"]]
};

const getters = {
  stepMinutes: state => state.stepMinutes,
  visibleFireStep: state => state.visibleFireStep,
  totalLayers: state => state.loadedLayers.length,
  selectedFire: (state, getters, rootState, rootGetters) => {
    const fires = rootGetters.fires;
    if (state.selectedFire in fires) return fires[state.selectedFire];
    else return null;
  },
  ignitionMinutes: (state, getters) => {
    var fireData = getters.selectedFire;
    if (fireData && "ignition_hhmm" in fireData)
      return (
        parseInt(fireData.ignition_hhmm.slice(0, 2)) * 60 +
        parseInt(fireData.ignition_hhmm.slice(2))
      );
    else return 0;
  }
};

const mutations = {
  [SELECT_FIRE](state, newVal) {
    state.selectedFire = newVal;
  },
  [PHOENIX_ADD_SOURCE](state, payload) {
    var fireSlice = payload.fireSlice;
    var source = fireSlice.sourceName;

    // setup unique source
    payload.map.addSource(source, {
      type: "geojson",
      data: fireSlice.geojson
    });
    state.loadedSources.push(source);
  },
  [PHOENIX_ADD_LAYER](state, payload) {
    var fireSlice = payload.fireSlice;
    var layer;
    if (state.fire3DFlameHeight) {
      layer = {
        id: fireSlice.layerName,
        type: "fill-extrusion",
        source: fireSlice.sourceName,
        filter: ["has", "FLAME_HT"],
        layout: {
          visibility: "none"
        },
        paint: {
          "fill-extrusion-color": {
            property: "E_INTSTY",
            stops: state.fireIntensityLevels
          },
          "fill-extrusion-height": {
            property: "FLAME_HT",
            stops: [[0, 1], [300, 1000]]
          },
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": state.opacity
        }
      };
    } else {
      layer = {
        id: fireSlice.layerName,
        type: "fill",
        source: fireSlice.sourceName,
        layout: {
          visibility: "none"
        },
        paint: {
          "fill-color": {
            property: "E_INTSTY",
            stops: state.fireIntensityLevels
          },
          "fill-opacity": state.opacity
        }
      };
    }
    payload.map.addLayer(layer, payload.beforeLayer);
    state.loadedLayers.push(fireSlice.layerName);
  },
  [PHOENIX_SET_OPACITY](state, value) {
    state.opacity = value;
  },
  [TOGGLE_3D](state, value) {
    state.fire3DFlameHeight = value;
  },
  [CLEAR_FIRE](state, map) {
    // remove layers
    for (const layer of state.loadedLayers) map.removeLayer(layer);
    state.loadedLayers = [];
    // remove sources
    for (const source of state.loadedSources) map.removeSource(source);
    state.loadedSources = [];
    state.visibleFireStep = null;
  },
  [PHOENIX_TIME_STEP](state, newVal) {
    state.visibleFireStep = newVal;
  }
};

const actions = {
  clearMap: {
    // Every store module is responsible for cleaning up after itself
    // https://vuex.vuejs.org/guide/modules.html#register-global-action-in-namespaced-modules
    root: true,
    handler({ commit, rootGetters }) {
      // ensure any existing matsim/fire artifacts are removed
      commit(CLEAR_FIRE, rootGetters.mapInstance);
    }
  },
  select({ dispatch, commit, getters, rootGetters }, fire) {
    commit(SELECT_FIRE, fire);
    const fireData = getters.selectedFire;

    if (getters.selectedFire) dispatch("load");
    else commit(CLEAR_FIRE, rootGetters.mapInstance);

    if (fireData && fireData.smokeGeojson)
      dispatch("drawSmoke", fireData.smokeGeojson);
  },
  load({ dispatch, getters }) {
    var selectedFire = getters.selectedFire;
    if (selectedFire) {
      dispatch(
        "downloadAndCreateLayers",
        process.env.VUE_APP_EES_TILES_API + "/" + selectedFire.file
      );
    }
  },
  downloadAndCreateLayers({ dispatch, commit, getters, rootGetters }, url) {
    const map = rootGetters.mapInstance;
    commit(CLEAR_FIRE, map);
    commit(START_LOADING, null, { root: true });

    // download and pre-process the geojson for better performance while rendering
    // we will build our own sources and layers for each fire step
    fetch(url)
      .then(function(response) {
        return response.json();
      })
      .then(function(geojson) {
        var features = geojson.features;
        // first sort
        features.sort(function(a, b) {
          if (a.properties.HOUR_BURNT === null) return -1;
          if (b.properties.HOUR_BURNT === null) return 1;
          else return a.properties.HOUR_BURNT - b.properties.HOUR_BURNT;
        });
        // now we can efficiently set up sources
        const lastFeature = features[features.length - 1];
        const totalMinutes = lastFeature.properties.HOUR_BURNT * 60;
        const totalSteps = Math.ceil(totalMinutes / getters.stepMinutes);

        // this will track the geojson features array
        var j = 0;
        // skip nulls
        while (features[j].properties.HOUR_BURNT === null) j++;
        // generate a geojson object for each step
        for (var i = 0; i < totalSteps; i++) {
          // set a threshold
          var threshold = (i * getters.stepMinutes) / 60;
          // create a fresh geojson structure for this layer
          var sect = {
            type: "FeatureCollection",
            features: []
          };

          // add all features below the minutes threshold to this structure
          while (features[j].properties.HOUR_BURNT < threshold) {
            sect.features.push(features[j]);
            j++;
          }

          // create this layer
          var stepStr = i.toString();
          var layer = "phoenix-layer" + stepStr;
          var source = "phoenix-source" + stepStr;
          commit(PHOENIX_ADD_SOURCE, {
            map: map,
            fireSlice: {
              sourceName: source,
              geojson: sect
            }
          });
          commit(PHOENIX_ADD_LAYER, {
            map: map,
            beforeLayer: getters.fireBeforeLayer,
            fireSlice: {
              sourceName: source,
              layerName: layer
            }
          });
        }
        dispatch(
          "filter",
          getters.ignitionMinutes / getters.stepMinutes + totalSteps - 1,
          { root: true }
        ); // load the final fire step
        commit(DONE_LOADING, null, { root: true });
      });
  },
  filter: {
    root: true,
    handler({ getters, rootGetters, commit }, fireStep) {
      var map = rootGetters.mapInstance;

      var fireStartStep = getters.ignitionMinutes / getters.stepMinutes;

      // ensure every layer before the current step is on, and every one after is off
      for (var i = 0; i < getters.totalLayers; i++) {
        var layer = "phoenix-layer" + i.toString();
        if (i + fireStartStep <= fireStep)
          map.setLayoutProperty(layer, "visibility", "visible");
        else map.setLayoutProperty(layer, "visibility", "none");
      }
      commit(PHOENIX_TIME_STEP, fireStep);
    }
  },
  setOpacity({ getters, rootGetters, commit }, val) {
    const map = rootGetters.mapInstance;
    const totalLayers = getters.totalLayers;
    var i;
    var step;
    var layer;
    var paintProp;
    commit(PHOENIX_SET_OPACITY, val);

    if (state.fire3DFlameHeight) {
      paintProp = "fill-extrusion-opacity";
    } else {
      paintProp = "fill-opacity";
    }
    for (i = 0; i < totalLayers; i++) {
      step = i.toString();
      layer = "phoenix-layer" + step;
      map.setPaintProperty(layer, paintProp, val);
    }
  },
  reload: {
    root: true,
    handler({ dispatch }) {
      dispatch("resetFireLayers");
    }
  },
  resetFireLayers({ dispatch, rootGetters, getters, commit }) {
    const map = rootGetters.mapInstance;
    const totalLayers = getters.totalLayers;
    var i;
    var step;
    var layer;
    var source;

    // we dont want to clear, just reset each fire layer
    for (i = 0; i < totalLayers; i++) {
      step = i.toString();
      layer = "phoenix-layer" + step;
      map.removeLayer(layer);
    }
    state.loadedLayers = [];

    for (i = 0; i < totalLayers; i++) {
      step = i.toString();
      source = "phoenix-source" + step;
      layer = "phoenix-layer" + step;

      commit(PHOENIX_ADD_LAYER, {
        map: map,
        fireSlice: {
          sourceName: source,
          layerName: layer
        }
      });
    }
    dispatch("filter", getters.visibleFireStep, { root: true });
  },
  toggleFireIn3D({ dispatch, state, commit }) {
    commit(TOGGLE_3D, !state.fire3DFlameHeight, { root: true });
    commit(TOGGLE_3D, !state.fire3DFlameHeight);
    dispatch("resetFireLayers");
  }
};

export default {
  namespaced,
  state,
  getters,
  mutations,
  actions
};
