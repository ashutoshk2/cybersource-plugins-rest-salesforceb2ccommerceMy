'use strict';

var CustomObjectMgr = require('dw/object/CustomObjectMgr');
var Site = require('dw/system/Site');
var webhookSubscription = require('~/cartridge/scripts/webhookSubscription');

function WebhookModel() {
    this.CUSTOM_OBJECT_TYPE = 'CyberSource Webhook Subscription';
}

/**
 * Consolidates all data needed for the Webhook Manager view
 */
WebhookModel.prototype.getViewData = function () {
    var site = Site.getCurrent();
    var URLAction = require('dw/web/URLAction');
    var URLUtils = require('dw/web/URLUtils');
    
    var method = site.getCustomPreferenceValue('VisaAcceptance_Secure_Integration_Method');
    var methodValue = (method && method.value) ? method.value : (method || '');
    var dmEnabled = site.getCustomPreferenceValue('Cybersource_DecisionManager') || false;
    var ntEnabled = site.getCustomPreferenceValue('Cybersource_NetworkToken') || false;
    var webhookBaseUrl = site.getCustomPreferenceValue('Cybersource_Webhook_Base_URL') || '';
    var egressMleAlias = site.getCustomPreferenceValue('Cybersource_EgressCertificateAlias') || 'Cybersource_MLE_Egress_Private_Key';
    
    // Calculate what the URL looks like by default for this site
    var testAction = new URLAction('WebhookNotification-dmNotification', site.ID);
    var fullUrl = URLUtils.https(testAction).toString();
    var standardBaseUrl = fullUrl.substring(0, fullUrl.indexOf('WebhookNotification-dmNotification')).replace(/\/$/, '');

    var data = {
        config: {
            dmEnabled: dmEnabled,
            ntEnabled: ntEnabled,
            secureIntegrationMethod: methodValue,
            webhookBaseUrl: webhookBaseUrl,
            egressMleAlias: egressMleAlias,
            standardBaseUrl: standardBaseUrl,
            activeBaseUrl: webhookBaseUrl || standardBaseUrl
        },
        subscriptions: {},
        external: []
    };

    var products = ['fraudManagement', 'alternativePaymentMethods', 'tokenManagement'];
    products.forEach(function (productId) {
        try {
            var obj = CustomObjectMgr.getCustomObject('CyberSource Webhook Subscription', productId);
            data.subscriptions[productId] = obj ? { webhookId: obj.custom.WebhookId, status: obj.custom.Status } : null;
        } catch (e) { data.subscriptions[productId] = null; }
    });

    try {
        products.forEach(function (productId) {
            webhookSubscription.retrieveWebhooks(productId === 'fraudManagement' ? 'decisionManager' : productId, function (apiData, error) {
                if (!error && apiData) {
                    apiData.forEach(function (webhook) {
                        var isInternal = false;
                        Object.keys(data.subscriptions).forEach(function (key) {
                            if (data.subscriptions[key] && data.subscriptions[key].webhookId === webhook.webhookId) isInternal = true;
                        });
                        if (!isInternal) data.external.push({ productId: productId, webhookId: webhook.webhookId, url: webhook.webhookUrl });
                    });
                }
            });
        });
    } catch (e) {}
    return data;
};

/**
 * Silent Fix: Reconciles all features.
 */
WebhookModel.prototype.reconcile = function () {
    var viewData = this.getViewData();
    var config = viewData.config;
    var subs = viewData.subscriptions;
    if (config.dmEnabled && !subs.fraudManagement) webhookSubscription.subscribeFraudManagement();
    if (config.secureIntegrationMethod === 'Unified_Checkout' && !subs.alternativePaymentMethods) webhookSubscription.subscribeAPM();
    if (config.ntEnabled && !subs.tokenManagement) webhookSubscription.subscribeNetworkTokens();
};

/**
 * Updates feature preferences and webhooks.
 */
WebhookModel.prototype.updateFeatures = function (dm, method, nt) {
    var Transaction = require('dw/system/Transaction');
    var site = Site.getCurrent();
    Transaction.wrap(function () {
        try { site.setCustomPreferenceValue('Cybersource_DecisionManager', dm); } catch(e) {}
        try { site.setCustomPreferenceValue('VisaAcceptance_Secure_Integration_Method', method || null); } catch(e) {}
        try { site.setCustomPreferenceValue('Cybersource_NetworkToken', nt); } catch(e) {}
    });
    return this.syncWithPreferences();
};

/**
 * Explicit Sync: Matches webhooks to current Site Preferences.
 */
WebhookModel.prototype.syncWithPreferences = function () {
    var data = this.getViewData();
    var results = {};
    if (data.config.dmEnabled && !data.subscriptions.fraudManagement) {
        results.dm = webhookSubscription.subscribeFraudManagement();
    } else if (!data.config.dmEnabled && data.subscriptions.fraudManagement) {
        results.dm = webhookSubscription.unsubscribeFraudManagement();
    }
    if (data.config.secureIntegrationMethod === 'Unified_Checkout' && !data.subscriptions.alternativePaymentMethods) {
        results.uc = webhookSubscription.subscribeAPM();
    } else if (data.config.secureIntegrationMethod !== 'Unified_Checkout' && data.subscriptions.alternativePaymentMethods) {
        results.uc = webhookSubscription.unsubscribeAPM();
    }
    if (data.config.ntEnabled && !data.subscriptions.tokenManagement) {
        results.nt = webhookSubscription.subscribeNetworkTokens();
    } else if (!data.config.ntEnabled && data.subscriptions.tokenManagement) {
        results.nt = webhookSubscription.unsubscribeNetworkTokens();
    }
    return results;
};

/**
 * Updates advanced preferences and webhooks.
 */
WebhookModel.prototype.updateAdvanced = function (baseUrl, egressMleAlias) {
    var Transaction = require('dw/system/Transaction');
    var site = Site.getCurrent();
    Transaction.wrap(function () {
        try { site.setCustomPreferenceValue('Cybersource_Webhook_Base_URL', baseUrl || null); } catch(e) {}
        try { site.setCustomPreferenceValue('Cybersource_EgressCertificateAlias', egressMleAlias || 'Cybersource_MLE_Egress_Private_Key'); } catch(e) {}
    });
    return this.syncWithPreferences();
};

module.exports = WebhookModel;
