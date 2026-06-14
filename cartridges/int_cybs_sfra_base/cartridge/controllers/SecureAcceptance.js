'use strict';

var server = require('server');
var configObject = require('../configuration/index');
var secureResponseHelper = require('~/cartridge/scripts/helpers/secureResponseHelper');

if (configObject.cartridgeEnabled) {
    /**
     * Helper function to handle UC token creation and rendering
     * @param {boolean} isMiniCart - Flag to indicate if this is for mini cart
     * @param {string} selectedPaymentInstrumentId - Optional: specific TMS payment instrument ID
     * @param {Object} res - Response object
     * @param {Function} next - Next middleware function
     */
    function handleUCTokenCreation(isMiniCart, selectedPaymentInstrumentId, res, next) {
        var uc = require('~/cartridge/scripts/http/payments');
        var UcCaptureContext = uc.generateUcCaptureContext(isMiniCart, selectedPaymentInstrumentId);
        
        // Check if generateUcCaptureContext returned an error object
        if (!UcCaptureContext || typeof UcCaptureContext !== 'string' || UcCaptureContext.error) {
            var Logger = require('dw/system/Logger');
            var errorMsg = UcCaptureContext && UcCaptureContext.errorMessage
                ? UcCaptureContext.errorMessage
                : 'Failed to generate capture context';
            Logger.error('[SecureAcceptance.js] handleUCTokenCreation ERROR: {0}', errorMsg);
            // Do NOT return the raw error to the browser. This action is consumed via a
            // server-side <isinclude url> (and client AJAX with dataType:'html'), so
            // res.json() would inline the gateway response verbatim into the storefront.
            // Render the UC template with a null capture context instead: checkout then
            // shows a generic message and the minicart shows nothing.
            secureResponseHelper.secureRender(res, 'unifiedCheckout', {
                UcCaptureContext: null,
                isMiniCart: isMiniCart,
                serverError: true
            });
            next();
            return;
        }
        
        var parsedPayload = uc.jwtDecode(UcCaptureContext);
        
        if (parsedPayload != null) {
            var clientLibrary = parsedPayload.ctx[0].data.clientLibrary;
            var clientLibraryIntegrity = parsedPayload.ctx[0].data.clientLibraryIntegrity;
            secureResponseHelper.secureRender(res, 'unifiedCheckout', {
                UcCaptureContext: UcCaptureContext,
                clientLibrary: clientLibrary,
                clientLibraryIntegrity: clientLibraryIntegrity
            });
            next();
        }
    }

    server.get('CreateUCToken', server.middleware.https, function (req, res, next) {
        handleUCTokenCreation(false, null, res, next);
    });

    server.get('CreateUCTokenMiniCart', server.middleware.https, function (req, res, next) {
        handleUCTokenCreation(true, null, res, next);
    });

    /**
     * CreateUCTokenWithCard - Generate capture context with a specific saved card
     * Used when customer selects a saved card from dropdown
     * UC widget will show "Pay now" button pre-populated with this card
     * @param {string} piId - Payment Instrument ID (TMS paymentInstrumentId)
     */
    server.get('CreateUCTokenWithCard', server.middleware.https, function (req, res, next) {
        var selectedPaymentInstrumentId = req.querystring.piId || null;
        
        if (!selectedPaymentInstrumentId) {
            res.json({ error: true, errorMessage: 'Payment instrument ID is required' });
            next();
            return;
        }
        
        // Validate format - basic alphanumeric check
        if (!/^[A-Za-z0-9]+$/.test(selectedPaymentInstrumentId)) {
            res.json({ error: true, errorMessage: 'Invalid payment instrument ID format' });
            next();
            return;
        }
        
        handleUCTokenCreation(false, selectedPaymentInstrumentId, res, next);
    });

    /**
     * GetSavedCards - Return list of saved payment instruments for card selector
     * Returns card details from SFCC wallet with TMS payment instrument IDs
     */
    server.get('GetSavedCards', server.middleware.https, function (req, res, next) {
        var Logger = require('dw/system/Logger');
        var savedCards = [];
        
        try {
            var customer = session.getCustomer();
            var customerProfile = customer ? customer.getProfile() : null;
            var isRegisteredCustomer = customer && customer.isRegistered() && customer.isAuthenticated() &&
                customerProfile && !empty(customerProfile.getEmail()) && !empty(customerProfile.getCustomerNo());
            
            if (isRegisteredCustomer && customerProfile) {
                var CustomerMgr = require('dw/customer/CustomerMgr');
                var dwOrderPaymentInstrument = require('dw/order/PaymentInstrument');
                var customerObj = CustomerMgr.getCustomerByCustomerNumber(customerProfile.customerNo);
                
                if (customerObj && customerObj.profile && customerObj.profile.wallet) {
                    var wallet = customerObj.profile.wallet;
                    var paymentInstruments = wallet.getPaymentInstruments(dwOrderPaymentInstrument.METHOD_CREDIT_CARD).toArray();
                    
                    for (var i = 0; i < paymentInstruments.length; i++) {
                        var pi = paymentInstruments[i];
                        var token = pi.creditCardToken;
                        
                        // Token format: instrumentIdentifierId-paymentInstrumentId-flex[-customerId]
                        if (!empty(token) && token.indexOf('-') > 0) {
                            var tokenParts = token.split('-');
                            if (tokenParts.length >= 2) {
                                var paymentInstrumentId = tokenParts[1];
                                
                                savedCards.push({
                                    paymentInstrumentId: paymentInstrumentId,
                                    cardType: pi.creditCardType || 'Card',
                                    maskedNumber: pi.maskedCreditCardNumber || '****',
                                    expirationMonth: pi.creditCardExpirationMonth || '',
                                    expirationYear: pi.creditCardExpirationYear || '',
                                    cardHolder: pi.creditCardHolder || ''
                                });
                            }
                        }
                    }
                }
            }
            
            res.json({
                success: true,
                savedCards: savedCards,
                hasSavedCards: savedCards.length > 0
            });
        } catch (e) {
            Logger.error('[SecureAcceptance.js] GetSavedCards ERROR: {0}', e.message);
            res.json({
                success: false,
                error: true,
                errorMessage: 'Failed to retrieve saved cards',
                savedCards: []
            });
        }
        
        next();
    });

    /**
     * CreateUCTokenSaveCard - Generate capture context for My Account "Add Payment" flow
     * Uses SAVE_CARD completeMandate type for tokenization without authorization
     * UC widget collects billing address (billingType: 'FULL')
     */
    server.get('CreateUCTokenSaveCard', server.middleware.https, function (req, res, next) {
        var uc = require('~/cartridge/scripts/http/payments');
        var UcCaptureContext = uc.generateUcCaptureContextSaveCard();
        
        // Check if generateUcCaptureContextSaveCard returned an error object
        if (!UcCaptureContext || typeof UcCaptureContext !== 'string' || UcCaptureContext.error) {
            var Logger = require('dw/system/Logger');
            var errorMsg = UcCaptureContext && UcCaptureContext.errorMessage 
                ? UcCaptureContext.errorMessage 
                : 'Failed to generate capture context for save card';
            Logger.error('[SecureAcceptance.js] CreateUCTokenSaveCard ERROR: {0}', errorMsg);
            res.json({ error: true, errorMessage: errorMsg });
            next();
            return;
        }
        
        var parsedPayload = uc.jwtDecode(UcCaptureContext);
        
        if (parsedPayload != null) {
            var clientLibrary = parsedPayload.ctx[0].data.clientLibrary;
            var clientLibraryIntegrity = parsedPayload.ctx[0].data.clientLibraryIntegrity;
            secureResponseHelper.secureRender(res, 'unifiedCheckoutSaveCard', {
                UcCaptureContext: UcCaptureContext,
                clientLibrary: clientLibrary,
                clientLibraryIntegrity: clientLibraryIntegrity
            });
            next();
        }
    });
}

module.exports = server.exports();
