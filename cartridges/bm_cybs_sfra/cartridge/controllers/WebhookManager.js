'use strict';

var server = require('server');
var webhookSubscription = require('*/cartridge/scripts/webhookSubscription');
var secureResponseHelper = require('~/cartridge/scripts/helpers/secureResponseHelper');

server.get('Show', server.middleware.https, function (req, res, next) {
    var viewData = webhookSubscription.getViewData();
    viewData.actionUrl = require('dw/web/URLUtils').url('WebhookManager-Save').toString();
    viewData.success = req.querystring.success === 'true';
    viewData.error = req.querystring.error;
    
    viewData.info = req.querystring.info;
    
    secureResponseHelper.secureRender(res, 'webhookManager', viewData);
    return next();
});

server.post('Save', server.middleware.https, function (req, res, next) {
    var action = req.form.action;
    var syncResults = null;

    if (action === 'sync') {
        syncResults = webhookSubscription.syncWithPreferences();
    } else if (action === 'advanced') {
        syncResults = webhookSubscription.updateAdvanced(req.form.egressMleAlias, req.form.egressPublicKey);
    }

    var redirectArgs = ['WebhookManager-Show'];
    var hasError = false;
    
    if (syncResults && syncResults.dm && syncResults.dm.success === false && syncResults.dm.error === 'NO_FRAUD_PRODUCT') {
        var Transaction = require('dw/system/Transaction');
        var Site = require('dw/system/Site');
        Transaction.wrap(function () {
            try { Site.getCurrent().setCustomPreferenceValue('VisaAcceptance_DecisionManager', false); } catch(e) {}
        });
        redirectArgs.push('error', 'no_fraud_product');
        hasError = true;
    }

    // UC subscribe failed because the Egress Public Key is missing.
    // Don't auto-disable the integration method (merchant may still be in setup);
    // just surface the error so the merchant uploads the key and re-syncs.
    if (!hasError && syncResults && syncResults.uc && syncResults.uc.success === false && syncResults.uc.error === 'EGRESS_KEY_REQUIRED') {
        redirectArgs.push('error', 'egress_key_required');
        hasError = true;
    }

    
    // Surface any other sync failure (API_ERROR, KEY_ERROR, ACTIVATION_ERROR,
    // PRODUCT_NOT_ENABLED, …) so a failed subscribe is not reported as "successful".
    if (!hasError && syncResults) {
        var failedKeys = Object.keys(syncResults).filter(function (key) {
            return syncResults[key] && syncResults[key].success === false;
        });
        if (failedKeys.length > 0) {
            redirectArgs.push('error', 'sync_failed');
            hasError = true;
        }
    }


    // Non-ACTIVE state (PENDING_REVIEW / INACTIVE / SUSPENDED) is surfaced live from the subscription
    // status in the view, not via a redirect flash — so the banner always matches the status column.
    if (!hasError) {
        redirectArgs.push('success', 'true');
    }

    res.redirect(require('dw/web/URLUtils').url.apply(null, redirectArgs));
    return next();
});

module.exports = server.exports();
