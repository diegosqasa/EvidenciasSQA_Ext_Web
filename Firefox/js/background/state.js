/**
 * Evidencias SQA — background/state.js
 */

export const workerState = {
    resultTabId: null,
    lastCaptureVisibleTabAt: 0,
    clearCompletedStatusTimer: null,
    permissionAllSite: 0,
    activeTab: null,
    nowShotImgData: undefined
};

export const captureStatus = {
    active: false,
    mode: null,
    progress: 0,
    phase: 'idle',
    message: '',
    error: '',
    tabId: null
};

export const captureInProgress = {
    activeTabs: new Set(),
    add: function(tabId) { this.activeTabs.add(tabId); },
    delete: function(tabId) { this.activeTabs.delete(tabId); },
    has: function(tabId) { return this.activeTabs.has(tabId); }
};
