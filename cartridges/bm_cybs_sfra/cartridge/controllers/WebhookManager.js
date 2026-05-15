'use strict';

var server = require('server');
var webhookSubscription = require('~/cartridge/scripts/webhookSubscription');

server.get('Show', server.middleware.https, function (req, res, next) {
    var viewData = webhookSubscription.getViewData();
    viewData.actionUrl = require('dw/web/URLUtils').url('WebhookManager-Save').toString();
    viewData.success = req.querystring.success === 'true';
    viewData.error = req.querystring.error;
    res.render('webhookManager', viewData);
    return next();
});

server.post('Save', server.middleware.https, function (req, res, next) {
    var action = req.form.action;
    var syncResults = null;

    if (action === 'sync') {
        syncResults = webhookSubscription.syncWithPreferences();
    } else if (action === 'advanced') {
        syncResults = webhookSubscription.updateAdvanced(req.form.webhookBaseUrl, req.form.egressMleAlias, req.form.egressPublicKey);
    }

    var redirectArgs = ['WebhookManager-Show'];
    var hasError = false;
    
    if (syncResults && syncResults.dm && syncResults.dm.success === false && syncResults.dm.error === 'NO_FRAUD_PRODUCT') {
        var Transaction = require('dw/system/Transaction');
        var Site = require('dw/system/Site');
        Transaction.wrap(function () {
            try { Site.getCurrent().setCustomPreferenceValue('Cybersource_DecisionManager', false); } catch(e) {}
        });
        redirectArgs.push('error', 'no_fraud_product');
        hasError = true;
    }

    if (!hasError) {
        redirectArgs.push('success', 'true');
    }

    res.redirect(require('dw/web/URLUtils').url.apply(null, redirectArgs));
    return next();
});

module.exports = server.exports();
