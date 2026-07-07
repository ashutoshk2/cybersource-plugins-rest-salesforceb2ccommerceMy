'use strict';

var page = module.superModule;
var server = require('server');
var secureResponseHelper = require('~/cartridge/scripts/helpers/secureResponseHelper');
server.extend(page);

/**
 * CheckoutServices-PlaceOrderDirect
 *
 * Handles order placement for UC v1.x completeMandate flow where authorization
 * has already been performed by the SDK. This endpoint:
 * 1. Validates the completeMandate JWT response
 * 2. Creates the order from basket
 * 3. Maps transaction details to payment instrument (skips authorization since SDK already did it)
 * 4. Runs fraud detection based on SDK response status
 * 5. Places the order and redirects to confirmation
 *
 * @param {Object} req - Request object containing completeMandateJwt parameter
 * @returns {Object} JSON response with orderID, orderToken, continueUrl or error
 */
server.post('PlaceOrderDirect', server.middleware.https, function (req, res, next) {
    var BasketMgr = require('dw/order/BasketMgr');
    var OrderMgr = require('dw/order/OrderMgr');
    var PaymentMgr = require('dw/order/PaymentMgr');
    var Resource = require('dw/web/Resource');
    var Transaction = require('dw/system/Transaction');
    var URLUtils = require('dw/web/URLUtils');
    var Logger = require('dw/system/Logger');
    var basketCalculationHelpers = require('*/cartridge/scripts/helpers/basketCalculationHelpers');
    var hooksHelper = require('*/cartridge/scripts/helpers/hooks');
    var COHelpers = require('*/cartridge/scripts/checkout/checkoutHelpers');
    var validationHelpers = require('*/cartridge/scripts/helpers/basketValidationHelpers');
    var addressHelpers = require('*/cartridge/scripts/helpers/addressHelpers');
    var payments = require('*/cartridge/scripts/http/payments');
    var ucPaymentHelper = require('~/cartridge/scripts/helpers/ucPaymentHelper');
    var webhookOrderStatusHelper = require('~/cartridge/scripts/helpers/webhookOrderStatusHelper');
    var configObject = require('~/cartridge/configuration/index.js');

    var logger = Logger.getLogger('VisaAcceptance', 'PlaceOrderDirect');

    // Get the completeMandate JWT from request
    var completeMandateJwt = request.httpParameterMap.completeMandateJwt.stringValue;
    var transientToken = request.httpParameterMap.transientToken.stringValue;

    if (!completeMandateJwt) {
        logger.error('PlaceOrderDirect: Missing completeMandateJwt parameter');
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        return next();
    }

    // Decode and validate the JWT
    var jwtPayload = payments.decodeCompleteMandateJwt(completeMandateJwt);

    if (!jwtPayload) {
        logger.error('PlaceOrderDirect: JWT validation failed');
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        return next();
    }

    // Get current basket
    var currentBasket = BasketMgr.getCurrentBasket();
    if (!currentBasket) {
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            cartError: true,
            fieldErrors: [],
            serverErrors: [],
            redirectUrl: URLUtils.url('Cart-Show').toString()
        });
        return next();
    }

    // Validate products in basket
    var validatedProducts = validationHelpers.validateProducts(currentBasket);
    if (validatedProducts.error) {
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            cartError: true,
            fieldErrors: [],
            serverErrors: [],
            redirectUrl: URLUtils.url('Cart-Show').toString()
        });
        return next();
    }

    // Check fraud detection status from session
    if (req.session.privacyCache.get('fraudDetectionStatus')) {
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            cartError: true,
            redirectUrl: URLUtils.url('Error-ErrorCode', 'err', '01').toString(),
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        return next();
    }



    // For minicart/cart flows: Populate addresses from transient token via getPaymentDetails API
    // UC widget captures billing/shipping via captureMandate when requestShipping=true, billingType='FULL'
    // The addresses are NOT in the completeMandate JWT - they come from the transient token API
    var paymentDetails = null;
    if (transientToken && (!currentBasket.billingAddress || !currentBasket.defaultShipment.shippingAddress)) {
        try {
            paymentDetails = payments.getPaymentDetails(transientToken);
            if (paymentDetails && paymentDetails.orderInformation) {
                // Populate addresses from API response
                ucPaymentHelper.populateBasketAddressesFromPaymentDetails(currentBasket, paymentDetails, Transaction);
                logger.info('PlaceOrderDirect: Addresses populated from getPaymentDetails API (minicart/cart flow)');

                // Set default shipping method if not present
                ucPaymentHelper.setDefaultShippingMethod(currentBasket, Transaction);

                // // Recalculate basket totals with new addresses (for tax calculation)
                // Transaction.wrap(function () {
                //     basketCalculationHelpers.calculateTotals(currentBasket);
                // });
            }
        } catch (e) {
            logger.error('PlaceOrderDirect: Error getting payment details from transient token: {0}', e.message || e);
        }
    }

    // Check authorization status
    // Runs AFTER address population so the express (minicart/cart) flow persists the UC/wallet-collected
    // address to the basket even when authorization fails - the client redirects to Checkout-Begin on
    // failure, and the address must already be on the basket for the checkout page to show it.
    var authStatus = jwtPayload.status;
    if (!ucPaymentHelper.isValidAuthorizationStatus(authStatus)) {
        logger.error('PlaceOrderDirect: Authorization not successful. Status: {0}', authStatus);

        // Check if SCA (Strong Customer Authentication) is required
        // Expanded SCA detection for new Visa Acceptance response patterns
        var isSCARequired = false;
        var processorInfo = jwtPayload.details && jwtPayload.details.processorInformation;
        var reasonCode = processorInfo && processorInfo.responseCode;
        var reason = jwtPayload.reason;
        var message = jwtPayload.message;
        var outcome = jwtPayload.outcome;
        // SCA required indicators: response 478, authentication_required status, or new Visa Acceptance patterns
        if (
            reasonCode === '478' ||
            authStatus === 'AUTHENTICATION_REQUIRED' ||
            authStatus === 'PENDING_AUTHENTICATION' ||
            (reason && reason === 'CUSTOMER_AUTHENTICATION_REQUIRED') ||
            (message && typeof message === 'string' && message.toLowerCase().indexOf('strong customer authentication required') !== -1)
        ) {
            isSCARequired = true;
            ucPaymentHelper.setSCARequiredFlag();
            logger.info('PlaceOrderDirect: SCA required detected (reasonCode: {0}, status: {1}, reason: {2}, outcome: {3}). Flag set for retry.', reasonCode, authStatus, reason, outcome);
        }

        // Return appropriate error message
        var errorMessage;
        if (isSCARequired) {
            errorMessage = ucPaymentHelper.getSCAErrorMessage();
        } else {
            errorMessage = ucPaymentHelper.getAuthorizationErrorMessage(authStatus) || Resource.msg('error.technical', 'checkout', null);
        }

        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorMessage: errorMessage,
            scaRequired: isSCARequired
        });
        return next();
    }

    // Validate order
    var validationOrderStatus = hooksHelper('app.validate.order', 'validateOrder', currentBasket, require('*/cartridge/scripts/hooks/validateOrder').validateOrder);
    if (validationOrderStatus.error) {
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorMessage: validationOrderStatus.message
        });
        return next();
    }

    // Check shipping address exists
    if (currentBasket.defaultShipment.shippingAddress === null) {
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorStage: { stage: 'shipping', step: 'address' },
            errorMessage: Resource.msg('error.no.shipping.address', 'checkout', null)
        });
        return next();
    }

    // Check billing address exists
    if (!currentBasket.billingAddress) {
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorStage: { stage: 'payment', step: 'billingAddress' },
            errorMessage: Resource.msg('error.no.billing.address', 'checkout', null)
        });
        return next();
    }

    // Detect payment type from completeMandate JWT (transient token is the fallback
    // signal for APMs whose result JWT is bare, e.g. Tink Pay by Bank).
    var detectedPaymentMethod = ucPaymentHelper.detectPaymentMethod(jwtPayload, transientToken);
    var isDigitalWallet = detectedPaymentMethod === 'DW_GOOGLE_PAY' || detectedPaymentMethod === 'DW_APPLE_PAY' || detectedPaymentMethod === 'DW_PAZE';;

    // Bank transfer Handle needs routing/account from getPaymentDetails. Reuse the
    // response fetched above for addresses; fetch here only if not already done.
    if (detectedPaymentMethod === 'BANK_TRANSFER' && !paymentDetails && transientToken) {
        try {
            paymentDetails = payments.getPaymentDetails(transientToken);
        } catch (e) {
            logger.error('PlaceOrderDirect: getPaymentDetails for BANK_TRANSFER failed: {0}', e.message || e);
            secureResponseHelper.secureJsonResponse(res, {
                error: true,
                errorMessage: Resource.msg('error.technical', 'checkout', null)
            });
            return next();
        }
    }

    // Delegate payment instrument creation to the registered Handle hook for
    // the resolved processor. Each hook owns its own Transaction.wrap and
    // method-specific instrument setup.
    var processorId = ucPaymentHelper.getProcessorIdForMethod(detectedPaymentMethod);
    if (!processorId) {
        logger.error('PlaceOrderDirect: No processor mapped for method {0}', detectedPaymentMethod);
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        return next();
    }

    // Resolve the dw.order.PaymentProcessor up-front so we can fail loudly here
    // (with the exact missing record name) rather than silently skipping
    // setPaymentProcessor inside the post-order Transaction.wrap, which would
    // leave PaymentTransaction.paymentProcessor null and break refund/capture
    // flows downstream. SFCC has no direct PaymentProcessor lookup, so we go
    // through the PaymentMethod — but routing is already decided by the static
    // map above; this lookup only resolves the dw.order.PaymentProcessor object
    // needed by setPaymentProcessor().
    var paymentMethod = PaymentMgr.getPaymentMethod(detectedPaymentMethod);
    if (!paymentMethod) {
        logger.error(
            'PlaceOrderDirect: PaymentMethod record "{0}" missing in BM. Create it under Merchant Tools > Site Preferences > Payment Methods.',
            detectedPaymentMethod
        );
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        return next();
    }
    var paymentProcessor = paymentMethod.getPaymentProcessor();
    if (!paymentProcessor) {
        logger.error(
            'PlaceOrderDirect: PaymentMethod "{0}" has no PaymentProcessor bound in BM. Bind it to a processor under Merchant Tools > Site Preferences > Payment Methods.',
            detectedPaymentMethod
        );
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        return next();
    }

    var ucPaymentInformation = {
        jwtPayload: jwtPayload,
        transientToken: transientToken,
        paymentMethod: detectedPaymentMethod,
        isDigitalWallet: isDigitalWallet,
        paymentDetails: paymentDetails,
        fromUC: true
    };

    var handleResult = hooksHelper(
        'app.payment.processor.' + processorId,
        'Handle',
        currentBasket,
        ucPaymentInformation,
        require('app_storefront_base/cartridge/scripts/hooks/payment/processor/basic_credit').Handle
    );
    if (handleResult.error) {
        logger.error('PlaceOrderDirect: Handle hook failed for method {0} (processor {1})', detectedPaymentMethod, processorId);
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorMessage: Resource.msg('error.payment.not.valid', 'checkout', null)
        });
        return next();
    }

    // // Calculate basket totals
    // Transaction.wrap(function () {
    //     basketCalculationHelpers.calculateTotals(currentBasket);
    // });

    // Validate payment instruments
    // var validPayment = COHelpers.validatePayment(req, currentBasket);
    // if (validPayment.error) {
    //     secureResponseHelper.secureJsonResponse(res, {
    //         error: true,
    //         errorStage: { stage: 'payment', step: 'paymentInstrument' },
    //         errorMessage: Resource.msg('error.payment.not.valid', 'checkout', null)
    //     });
    //     return next();
    // }

    // Calculate payment transaction
    var calculatedPaymentTransactionTotal = COHelpers.calculatePaymentTransaction(currentBasket);
    if (calculatedPaymentTransactionTotal.error) {
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        return next();
    }

    // Create order from basket using the Visa Acceptance clientReferenceInformation.code
    // as the SFCC order number. That code is the merchant reference the transaction was
    // created against and the key the webhooks reconcile on (OrderMgr.getOrder(code)),
    // so the order number MUST equal it. It is taken from the JWT (authoritative) rather
    // than session.privacy.ucOrderNo, which a redirect APM (iDEAL/Multibanco) flow may
    // have dropped.
    var clientReferenceCode = jwtPayload.details &&
        jwtPayload.details.clientReferenceInformation &&
        jwtPayload.details.clientReferenceInformation.code;

    // Known issue: for PayPal the completeMandate result does not echo the
    // merchant reference (clientReferenceInformation.code) we sent and returns 'default'.
    // Fall back to the order number reserved at capture-context time, then clear it.
    if (!clientReferenceCode || clientReferenceCode === 'default') {
        var reservedOrderNo = session.privacy.ucOrderNo;
        if (reservedOrderNo) {
            clientReferenceCode = reservedOrderNo;
            session.privacy.ucOrderNo = null;
        }
    }
    var order = COHelpers.createOrder(currentBasket, clientReferenceCode);
    if (!order) {
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        return next();
    }

    // Extract transaction details from JWT payload
    var transactionId = jwtPayload.id;
    var processorInfo = jwtPayload.details && jwtPayload.details.processorInformation;

    // Set order status in session for fraud detection hook
    session.privacy.orderStatus = authStatus;

    // Carry eCheck bank details out of the Transaction.wrap so the TMS save block
    // below can reuse the same getPaymentDetails-enriched values without calling the
    // API twice. Stays null for non-eCheck flows.
    var enrichedBankDetails = null;

    // Update payment instrument with transaction details from SDK authorization
    try {
        Transaction.wrap(function () {
            var paymentInstruments = order.getPaymentInstruments();
            if (paymentInstruments.length > 0) {
                var paymentInstrument = paymentInstruments[0];

                // Set transaction ID and processor (paymentProcessor resolved up-front,
                // guaranteed non-null by the guard at line ~232).
                paymentInstrument.paymentTransaction.setTransactionID(transactionId);
                paymentInstrument.paymentTransaction.setPaymentProcessor(paymentProcessor);


                var isApmFlow = (
                    detectedPaymentMethod === 'ALT_PAYMENT_METHOD' ||
                    detectedPaymentMethod === 'PAYPAL' ||
                    detectedPaymentMethod === 'VENMO'
                );
                if (isApmFlow) {
                    // Alternate payment methods (PPRO bank transfers, BNPL, PayPal,
                    // Venmo, Paze, ...) carry no card/bank-account data. Record the
                    // scheme descriptor instead of card details.
                    var apmDescriptor = ucPaymentHelper.getApmDescriptor(jwtPayload, transientToken) || { name: '', method: '' };
                    // Customer-facing scheme name (e.g. 'iDEAL') for the confirmation /
                    // email payment section. paymentDetails is the reliably-imported
                    // PaymentTransaction attribute, so it must carry the readable label -
                    // the optional apm* instrument attributes may be absent in metadata.
                    var apmDetailsStr = ucPaymentHelper.getApmDisplayName(apmDescriptor);
                    paymentInstrument.paymentTransaction.custom.paymentDetails = apmDetailsStr;
                    ucPaymentHelper.setInstrumentCustomAttribute(paymentInstrument, 'apmPaymentType', apmDetailsStr);
                    ucPaymentHelper.setInstrumentCustomAttribute(paymentInstrument, 'apmMethod', apmDescriptor.method);
                    ucPaymentHelper.setInstrumentCustomAttribute(paymentInstrument, 'apmMandateType', session.privacy.ucResolvedMandateType);
                } else if (detectedPaymentMethod === 'BANK_TRANSFER') {
                    // eCheck (ACH). The transient JWT carries schema-only placeholders for
                    // bank.routingNumber and bank.account.number ({}, not real values), so
                    // we fetch the populated bank details via the TransientTokenData API
                    // (getPaymentDetails) and merge them into extractBankDetailsFromTransient's
                    // output. Reuse the credit-card wallet slots so the SFRA payment summary,
                    // confirmation page, and email render eCheck in the same column as PAN entries.
                    var bankDetails = ucPaymentHelper.extractBankDetailsFromTransient(transientToken, order.billingAddress);
                    try {
                        var pd = payments.getPaymentDetails(transientToken);
                        var pdBank = pd && pd.paymentInformation && pd.paymentInformation.bank;
                        if (pdBank) {
                            if (!bankDetails.routingNumber && pdBank.routingNumber) {
                                bankDetails.routingNumber = typeof pdBank.routingNumber === 'string'
                                    ? pdBank.routingNumber
                                    : (pdBank.routingNumber.value || '');
                            }
                            if (pdBank.account) {
                                var pdAccountNum = typeof pdBank.account.number === 'string'
                                    ? pdBank.account.number
                                    : (pdBank.account.number && (pdBank.account.number.maskedValue || pdBank.account.number.value)) || '';
                                if (!bankDetails.maskedAccount && pdAccountNum) {
                                    bankDetails.maskedAccount = pdAccountNum;
                                    if (pdAccountNum.length >= 4) {
                                        bankDetails.last4 = pdAccountNum.slice(-4);
                                    }
                                }
                            }
                        }
                    } catch (pdErr) {
                        logger.warn('PlaceOrderDirect: getPaymentDetails lookup failed for eCheck: {0}', pdErr.message || pdErr);
                    }
                    enrichedBankDetails = bankDetails;
                    if (bankDetails.accountHolder && !paymentInstrument.creditCardHolder) {
                        paymentInstrument.setCreditCardHolder(bankDetails.accountHolder);
                    }
                    if (bankDetails.last4) {
                        paymentInstrument.setCreditCardNumber('••••' + bankDetails.last4);
                    }
                    paymentInstrument.setCreditCardType('eCheck');
                    if (bankDetails.routingNumber) {
                        ucPaymentHelper.setInstrumentCustomAttribute(paymentInstrument, 'echeckRoutingNumber', bankDetails.routingNumber);
                    }
                    paymentInstrument.paymentTransaction.custom.paymentDetails =
                        ucPaymentHelper.buildEcheckPaymentDetailsString(bankDetails);
                } else {
                    // Extract and set card details (pass order billing address for cardholder name)
                    var cardDetails = ucPaymentHelper.extractCardDetails(jwtPayload, transientToken, order.billingAddress);
                    ucPaymentHelper.updatePaymentInstrumentCardDetails(paymentInstrument, cardDetails, isDigitalWallet);

                    // Set payment details string
                    var paymentDetailsStr = ucPaymentHelper.buildPaymentDetailsString(cardDetails);
                    paymentInstrument.paymentTransaction.custom.paymentDetails = paymentDetailsStr;
                }

                // Store optional processor info. Guard each field individually:
                // processorInfo may be present while approvalCode / networkTransactionId
                // are absent for some payment methods (e.g. Pay by Bank), and writing
                // undefined surfaces a literal "undefined" in the BM payment section.
                if (processorInfo) {
                    if (processorInfo.approvalCode) {
                        paymentInstrument.paymentTransaction.custom.approvalCode = processorInfo.approvalCode;
                    }
                    if (processorInfo.networkTransactionId) {
                        paymentInstrument.paymentTransaction.custom.networkTransactionId = processorInfo.networkTransactionId;
                    }
                }
                if (jwtPayload.details && jwtPayload.details.reconciliationId) {
                    paymentInstrument.paymentTransaction.custom.reconciliationId = jwtPayload.details.reconciliationId;
                }

                // Reconciliation fields per ISV Integration Guide Section 13.
                var clientRefCode = jwtPayload.details
                    && jwtPayload.details.clientReferenceInformation
                    && jwtPayload.details.clientReferenceInformation.code;
                // if (clientRefCode) {
                //     paymentInstrument.paymentTransaction.custom.clientReferenceCode = clientRefCode;
                // }
                if (processorInfo && processorInfo.transactionId) {
                    paymentInstrument.paymentTransaction.custom.processorTransactionId = processorInfo.transactionId;
                }
                // paymentInstrument.paymentTransaction.custom.authMethod = (configObject.authenticationType || '').toUpperCase();
                paymentInstrument.paymentTransaction.custom.resultTimestamp = new Date().toISOString();

                // Gateway transaction status (jwtPayload.status, e.g. AUTHORIZED / PENDING).
                // Normalized to the same Title Case the webhook status helper writes, so a later
                // settlement/capture webhook upgrades this value cleanly. Guarded so an absent
                // status doesn't surface a literal "undefined" in the BM payment section.
                if (authStatus) {
                    paymentInstrument.paymentTransaction.custom.cybsTransactionStatus =
                        webhookOrderStatusHelper.formatTransactionStatus(authStatus);
                }


                logger.info('PlaceOrderDirect: Payment instrument updated - TransactionID: {0}, PaymentDetails: {1}, PaymentMethod: {2}',
                    transactionId, paymentInstrument.paymentTransaction.custom.paymentDetails, paymentInstrument.paymentMethod);
            }
        });
    } catch (e) {
        logger.error('PlaceOrderDirect: Error updating payment instrument: {0}', e.message || e);
        Transaction.wrap(function () { OrderMgr.failOrder(order, true); });
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        return next();
    }

    // Run fraud detection hook
    var fraudDetectionStatus = hooksHelper('app.fraud.detection', 'fraudDetection', currentBasket, require('*/cartridge/scripts/hooks/fraudDetection').fraudDetection);
    if (fraudDetectionStatus.status === 'fail') {
        Transaction.wrap(function () { OrderMgr.failOrder(order, true); });
        req.session.privacyCache.set('fraudDetectionStatus', true);
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            cartError: true,
            redirectUrl: URLUtils.url('Error-ErrorCode', 'err', fraudDetectionStatus.errorCode).toString(),
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        return next();
    }

    // Place the order
    var placeOrderResult = COHelpers.placeOrder(order, fraudDetectionStatus);
    if (placeOrderResult.error) {
        secureResponseHelper.secureJsonResponse(res, {
            error: true,
            errorMessage: Resource.msg('error.technical', 'checkout', null)
        });
        return next();
    }

    // Asynchronous/redirect alternate payment methods authorize as PENDING or
    // SETTLE_INITIATED in the result JWT and settle later. If no settlement webhook has
    // already confirmed the order above, leave it NOTCONFIRMED so it is not treated as
    // fully paid until the WebhookNotification reconciliation promotes it. (SFCC has no
    // request-time async to poll refresh-payment-status here.)
    if ((authStatus === 'PENDING' || authStatus === 'SETTLE_INITIATED') && order.getConfirmationStatus().getValue() !== order.CONFIRMATION_STATUS_CONFIRMED) {
        Transaction.wrap(function () {
            order.setConfirmationStatus(order.CONFIRMATION_STATUS_NOTCONFIRMED);
        });
        logger.info('PlaceOrderDirect: Order {0} left NOTCONFIRMED pending APM settlement (status PENDING)', order.orderNo);
    }


    // Save TMS token to customer wallet only when the consumer explicitly opted in
    // (transient token metadata.consumerPreference.saveCard === true), the auth response
    // returned tokenInformation, and the shopper is authenticated. Triple-gating lives
    // inside saveTokenToWallet — we just supply the display details.
    //
    // For eCheck (BANK_TRANSFER) the response has no card object, so we synthesize a
    // card-shaped record from the transient token's bank.account / bank.routingNumber.
    // Stored under METHOD_CREDIT_CARD with creditCardType="eCheck" so the same wallet
    // selector, GetSavedCards, and CreateUCTokenWithCard pipelines that handle PAN
    // automatically handle saved eCheck instruments too.
    var detailsForWallet;
    if (detectedPaymentMethod === 'BANK_TRANSFER') {
        // Reuse the getPaymentDetails-enriched bankDetails computed above. The JWT-only
        // extractBankDetailsFromTransient returns empty placeholders, so falling back to
        // it here would re-introduce the null routing-number tile bug.
        var echeckDetails = enrichedBankDetails
            || ucPaymentHelper.extractBankDetailsFromTransient(transientToken, order.billingAddress);
        detailsForWallet = {
            cardHolderName: echeckDetails.accountHolder,
            cardTypeName: 'eCheck',
            maskedNumber: echeckDetails.last4 ? ('••••' + echeckDetails.last4) : '',
            expirationMonth: '',
            expirationYear: '',
            echeckRoutingNumber: echeckDetails.routingNumber || ''
        };
    } else {
        detailsForWallet = ucPaymentHelper.extractCardDetails(jwtPayload, transientToken, order.billingAddress);
    }
    var tokenSaved = ucPaymentHelper.saveTokenToWallet(jwtPayload, detailsForWallet, session.getCustomer(), transientToken);
    if (tokenSaved) {
        logger.info('PlaceOrderDirect: TMS token saved to customer wallet (method: {0})', detectedPaymentMethod);

        // Maintain the default saved card, mirroring PaymentInstruments-SavePaymentDirect
        // (My Account). saveTokenToWallet/upsertCreditCard only preserve an existing card's
        // default flag on replace; they never promote a brand-new card, so the controller
        // owns this invariant. Checkout has no "make default" checkbox, so the rule is simply:
        // the first (only) saved card becomes the default, with ensureSingleDefault as a guard.
        try {
            var defaultPaymentHelper = require('~/cartridge/scripts/helpers/defaultPaymentHelper');
            var CustomerMgr = require('dw/customer/CustomerMgr');
            var checkoutCustomer = CustomerMgr.getCustomerByCustomerNumber(req.currentCustomer.profile.customerNo);
            var defaultWallet = checkoutCustomer.getProfile().getWallet();
            var savedCards = defaultPaymentHelper.getCreditCardInstruments(defaultWallet);
            if (savedCards.length > 0) {
                // Identify the card we just saved/updated by its instrumentIdentifier (robust
                // against wallet ordering and against an upsert that replaced an existing card).
                var savedTokenInfo = ucPaymentHelper.extractTokenInformation(jwtPayload);
                var savedPI = (savedTokenInfo && savedTokenInfo.instrumentIdentifier)
                    ? ucPaymentHelper.findCreditCardByInstrumentIdentifier(defaultWallet, savedTokenInfo.instrumentIdentifier.id)
                    : null;
                if (savedPI && savedCards.length === 1) {
                    defaultPaymentHelper.setDefaultByUUID(defaultWallet, savedPI.UUID);
                } else {
                    defaultPaymentHelper.ensureSingleDefault(defaultWallet);
                }
            }
        } catch (defErr) {
            logger.warn('PlaceOrderDirect: default-card maintenance skipped: {0}', defErr.message || defErr);
        }
    }

    // Save addresses to address book for logged in customers
    if (req.currentCustomer.addressBook) {
        var allAddresses = addressHelpers.gatherShippingAddresses(order);
        allAddresses.forEach(function (address) {
            if (!addressHelpers.checkIfAddressStored(address, req.currentCustomer.addressBook.addresses)) {
                addressHelpers.saveAddress(address, req.currentCustomer, addressHelpers.generateAddressName(address));
            }
        });
    }

    // Send confirmation email
    if (order.getCustomerEmail()) {
        COHelpers.sendConfirmationEmail(order, req.locale.id);
    }

    // Reset multi-shipping flag
    req.session.privacyCache.set('usingMultiShipping', false);

    logger.info('PlaceOrderDirect: Order placed successfully. OrderNo: {0}, TransactionID: {1}', order.orderNo, transactionId);

    // Return success
    secureResponseHelper.secureJsonResponse(res, {
        error: false,
        orderID: order.orderNo,
        orderToken: order.orderToken,
        continueUrl: URLUtils.url('Order-Confirm').toString()
    });

    return next();
});

module.exports = server.exports();
