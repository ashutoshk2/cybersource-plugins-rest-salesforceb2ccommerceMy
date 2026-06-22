'use strict';

/**
 * Helper functions for Unified Checkout payment processing
 * Includes:
 * - Token processing and address population
 * - completeMandate helpers for PlaceOrderDirect flow
 * - Capture context building helpers
 * - TMS token saving helpers
 */

var Transaction = require('dw/system/Transaction');
var Logger = require('dw/system/Logger');
var logger = Logger.getLogger('Cybersource', 'UCPaymentHelper');

// ============================================================================
// Token Processing Functions
// ============================================================================

/**
 * Process UC payment token and populate basket with billing/shipping addresses
 * @param {string} token - UC JWT token
 * @returns {Object} Payment details from UC API
 */
function processUCToken(token) {
    var payments = require('~/cartridge/scripts/http/payments.js');

    if (!token) {
        throw new Error('UC payment token is required');
    }

    var paymentDetails;
    try {
        paymentDetails = payments.getPaymentDetails(token);
    } catch (e) {
        var errorMsg = (e instanceof Error) ? e.message : String(e);
        throw new Error('Failed to retrieve payment details from Unified Checkout: ' + errorMsg);
    }

    return paymentDetails;
}

/**
 * Populate basket addresses from UC payment details
 * Only populates if addresses are empty (minicart flow)
 * Normal checkout flow already has addresses populated before form processor
 * @param {dw.order.Basket} basket - Current basket
 * @param {Object} paymentDetails - Payment details from UC API
 * @param {Object} paymentForm - Payment form object
 */
function populateBasketAddresses(basket, paymentDetails, paymentForm) {
    var shipment = basket.getDefaultShipment();
    var isEmailRequired = empty(basket.getCustomerEmail()) || empty(basket.customerEmail) || basket.getCustomerEmail() === 'undefined' || basket.customerEmail === 'undefined';

    Transaction.wrap(function () {
        var shippingAddress = shipment.createShippingAddress();

        var shipTo = paymentDetails.orderInformation.shipTo;
        shippingAddress.setFirstName(shipTo.firstName);
        shippingAddress.setLastName(shipTo.lastName);
        shippingAddress.setAddress1(shipTo.address1);
        if (!empty(shipTo.address2)) {
            shippingAddress.setAddress2(shipTo.address2);
        }
        shippingAddress.setCity(shipTo.locality);
        shippingAddress.setPostalCode(shipTo.postalCode);
        shippingAddress.setCountryCode(shipTo.country);
        shippingAddress.setStateCode(shipTo.administrativeArea);
        if (shipTo.phoneNumber) {
            shippingAddress.setPhone(shipTo.phoneNumber);
        }

        // Populate billing address
        var billingAddress = basket.createBillingAddress();
        var billTo = paymentDetails.orderInformation.billTo;
        billingAddress.setFirstName(billTo.firstName);
        billingAddress.setLastName(billTo.lastName);
        billingAddress.setAddress1(billTo.address1);
        if (!empty(billTo.address2)) {
            billingAddress.setAddress2(billTo.address2);
        }
        billingAddress.setCity(billTo.locality);
        billingAddress.setPostalCode(billTo.postalCode);
        billingAddress.setCountryCode(billTo.country);
        billingAddress.setStateCode(billTo.administrativeArea);
        billingAddress.setPhone(billTo.phoneNumber);
        if (isEmailRequired) {
            basket.setCustomerEmail(billTo.email);
        }
        // If shipping phone is empty, copy billing phone to shipping
        if (empty(shipTo.phoneNumber)) {
            if (billTo.phoneNumber) {
                shippingAddress.setPhone(billTo.phoneNumber);
            }
        }
        // Always update paymentForm billing fields if provided
        if (paymentForm && paymentForm.addressFields) {
            paymentForm.addressFields.firstName.value = billTo.firstName;
            paymentForm.addressFields.lastName.value = billTo.lastName;
            paymentForm.addressFields.address1.value = billTo.address1;
            if (!empty(billTo.address2)) {
                paymentForm.addressFields.address2.value = billTo.address2;
            }
            paymentForm.addressFields.city.value = billTo.locality;
            paymentForm.addressFields.postalCode.value = billTo.postalCode;
            paymentForm.addressFields.country.value = billTo.country;
            if (paymentForm.addressFields.states && billTo.administrativeArea) {
                paymentForm.addressFields.states.stateCode.value = billTo.administrativeArea;
            }
            if (paymentForm.contactInfoFields && billTo.phoneNumber) {
                paymentForm.contactInfoFields.phone.value = billTo.phoneNumber;
            }
        }
    });
}

/**
 * Update viewData object from populated payment form
 * @param {Object} paymentForm - Payment form object (already populated)
 * @param {Object} viewData - Existing viewData object to update
 * @returns {Object} Updated viewData object
 */
function updateViewDataFromForm(paymentForm, viewData) {
    var updatedViewData = viewData || {};

    if (paymentForm && paymentForm.addressFields) {
        updatedViewData.address = {
            firstName: { value: paymentForm.addressFields.firstName.value },
            lastName: { value: paymentForm.addressFields.lastName.value },
            address1: { value: paymentForm.addressFields.address1.value },
            address2: { value: paymentForm.addressFields.address2.value },
            city: { value: paymentForm.addressFields.city.value },
            postalCode: { value: paymentForm.addressFields.postalCode.value },
            countryCode: { value: paymentForm.addressFields.country.value }
        };

        if (Object.prototype.hasOwnProperty.call(paymentForm.addressFields, 'states')) {
            updatedViewData.address.stateCode = { value: paymentForm.addressFields.states.stateCode.value };
        }
    }

    if (paymentForm && paymentForm.contactInfoFields) {
        updatedViewData.phone = { value: paymentForm.contactInfoFields.phone.value };
    }

    return updatedViewData;
}

/**
 * Populate basket addresses from getPaymentDetails API response
 * Simplified version for PlaceOrderDirect flow (no paymentForm needed)
 * @param {dw.order.Basket} basket - Current basket
 * @param {Object} paymentDetails - Payment details from getPaymentDetails API
 * @param {Object} TransactionObj - DW Transaction object
 */
function populateBasketAddressesFromPaymentDetails(basket, paymentDetails, TransactionObj) {
    if (!paymentDetails || !paymentDetails.orderInformation) {
        logger.warn('populateBasketAddressesFromPaymentDetails: No orderInformation in paymentDetails');
        return;
    }

    var orderInfo = paymentDetails.orderInformation;
    var shipment = basket.getDefaultShipment();

    TransactionObj.wrap(function () {
        // Populate shipping address if shipTo exists in response
        if (orderInfo.shipTo && !shipment.shippingAddress) {
            var shippingAddress = shipment.createShippingAddress();
            var shipTo = orderInfo.shipTo;

            if (shipTo.firstName) shippingAddress.setFirstName(shipTo.firstName);
            if (shipTo.lastName) shippingAddress.setLastName(shipTo.lastName);
            if (shipTo.address1) shippingAddress.setAddress1(shipTo.address1);
            if (shipTo.address2) shippingAddress.setAddress2(shipTo.address2);
            if (shipTo.locality) shippingAddress.setCity(shipTo.locality);
            if (shipTo.postalCode) shippingAddress.setPostalCode(shipTo.postalCode);
            if (shipTo.country) shippingAddress.setCountryCode(shipTo.country);
            if (shipTo.administrativeArea) shippingAddress.setStateCode(shipTo.administrativeArea);
            if (shipTo.phoneNumber) shippingAddress.setPhone(shipTo.phoneNumber);

            logger.info('populateBasketAddressesFromPaymentDetails: Shipping address populated');
        }

        // Populate billing address if billTo exists in response
        if (orderInfo.billTo && !basket.billingAddress) {
            var billingAddress = basket.createBillingAddress();
            var billTo = orderInfo.billTo;

            if (billTo.firstName) billingAddress.setFirstName(billTo.firstName);
            if (billTo.lastName) billingAddress.setLastName(billTo.lastName);
            if (billTo.address1) billingAddress.setAddress1(billTo.address1);
            if (billTo.address2) billingAddress.setAddress2(billTo.address2);
            if (billTo.locality) billingAddress.setCity(billTo.locality);
            if (billTo.postalCode) billingAddress.setPostalCode(billTo.postalCode);
            if (billTo.country) billingAddress.setCountryCode(billTo.country);
            if (billTo.administrativeArea) billingAddress.setStateCode(billTo.administrativeArea);
            if (billTo.phoneNumber) billingAddress.setPhone(billTo.phoneNumber);

            if (billTo.email && !basket.customerEmail) {
                basket.setCustomerEmail(billTo.email);
            }

            logger.info('populateBasketAddressesFromPaymentDetails: Billing address populated');
        }

        // If shipping phone is empty but billing phone exists, copy it
        var shippingAddr = shipment.shippingAddress;
        if (shippingAddr && !shippingAddr.phone && orderInfo.billTo && orderInfo.billTo.phoneNumber) {
            shippingAddr.setPhone(orderInfo.billTo.phoneNumber);
        }
    });
}

/**
 * Make the transient-token amountDetails the source of truth for the order's tax/total.
 *
 * The UC widget authorizes the merchant-facing total it computed from the capture-context
 * request (including tax), and echoes it back in the transient token under
 * orderInformation.amountDetails. When SFCC's tax service computes a different value (e.g. a
 * sandbox with no tax provider), the storefront's Order-Confirm Total would not match what was
 * actually charged. This helper distributes the token's taxAmount across the basket's product
 * line items as a per-line tax RATE (SFCC's updateTax interprets its argument as a rate, not a
 * dollar amount), then recomputes basket aggregates via updateTotals() — which, unlike
 * calculateTotals, does NOT re-fire the dw.order.calculateTax hook (calculateAdjustments.js)
 * that would otherwise wipe these per-line values.
 *
 * @param {dw.order.Basket} basket - current basket
 * @param {Object} paymentDetails - decoded response from payments.getPaymentDetails
 * @param {Object} TransactionObj - dw/system/Transaction
 * @returns {boolean} - true if the override was applied, false on any no-op/guard
 */
function applyAmountDetailsFromPaymentDetails(basket, paymentDetails, TransactionObj) {
    if (!paymentDetails || !paymentDetails.orderInformation || !paymentDetails.orderInformation.amountDetails) {
        return false;
    }
    var amountDetails = paymentDetails.orderInformation.amountDetails;
    var tokenTaxAmount = parseFloat(amountDetails.taxAmount);
    var tokenTotalAmount = parseFloat(amountDetails.totalAmount);
    if (isNaN(tokenTaxAmount) || isNaN(tokenTotalAmount)) {
        return false;
    }

    // No churn if the storefront tax already matches the token (within a cent).
    var currentTax = basket.totalTax && basket.totalTax.available ? basket.totalTax.value : 0;
    if (Math.abs(currentTax - tokenTaxAmount) < 0.01) {
        return false;
    }

    var productLineItems = basket.getAllProductLineItems();
    if (!productLineItems || productLineItems.length === 0) {
        logger.warn('applyAmountDetailsFromPaymentDetails: basket has no product line items; cannot distribute tax');
        return false;
    }
    var pliArray = productLineItems.toArray();
    var Money = require('dw/value/Money');
    var currencyCode = basket.currencyCode;

    // Proportional weight base: sum of product-line gross prices.
    var totalGross = 0;
    for (var g = 0; g < pliArray.length; g++) {
        var grossMoney = pliArray[g].adjustedGrossPrice;
        if (grossMoney && grossMoney.available) {
            totalGross += grossMoney.value;
        }
    }
    if (totalGross <= 0) {
        return false;
    }

    TransactionObj.wrap(function () {
        var distributed = 0;
        var largestLine = null;
        var largestGross = -1;
        var largestLineShare = 0;
        var largestLineNet = 0;

        for (var i = 0; i < pliArray.length; i++) {
            var pli = pliArray[i];
            var lineGross = (pli.adjustedGrossPrice && pli.adjustedGrossPrice.available) ? pli.adjustedGrossPrice.value : 0;
            var lineNet = (pli.adjustedNetPrice && pli.adjustedNetPrice.available) ? pli.adjustedNetPrice.value : 0;

            // Per-line dollar share of the token tax, proportional to gross, rounded to cents.
            var share = Math.round((tokenTaxAmount * (lineGross / totalGross)) * 100) / 100;

            // Use the two-arg updateTax(rate, taxBasis) so we supply the basis explicitly:
            // tax = rate * basis = share, regardless of the site's net/gross taxation policy or
            // the "tax on adjusted price" preference (which otherwise make the one-arg basis
            // system-determined and not equal to adjustedNetPrice).
            var rate = lineNet > 0 ? (share / lineNet) : 0;
            pli.updateTax(rate, new Money(lineNet, currencyCode));
            distributed += share;

            if (lineGross > largestGross) {
                largestGross = lineGross;
                largestLine = pli;
                largestLineShare = share;
                largestLineNet = lineNet;
            }
        }

        // Reconcile rounding pennies on the largest line — again via the two-arg form with an
        // explicit basis so the corrected tax equals correctedShare exactly.
        var penny = Math.round((tokenTaxAmount - distributed) * 100) / 100;
        if (penny !== 0 && largestLine && largestLineNet > 0) {
            var correctedShare = largestLineShare + penny;
            largestLine.updateTax(correctedShare / largestLineNet, new Money(largestLineNet, currencyCode));
        }

        // Recompute basket aggregates from line-item state WITHOUT re-firing the calculate hooks.
        basket.updateTotals();
    });

    logger.info('applyAmountDetailsFromPaymentDetails: applied token taxAmount {0}; basket totalGrossPrice now {1}',
        tokenTaxAmount, basket.totalGrossPrice.value);
    return true;
}

// ============================================================================
// Card Type Mapping Functions
// ============================================================================

/**
 * Map CyberSource card type code to readable name
 * @param {string} cardTypeCode - CyberSource card type code (e.g., '001' for Visa)
 * @returns {string} - Readable card type name
 */
function mapCardType(cardTypeCode) {
    if (!cardTypeCode) return '';

    var cardTypeMap = {
        '001': 'Visa',
        '002': 'Master Card',
        '003': 'Amex',
        '004': 'Discover',
        '005': 'DinersClub',
        '006': 'Carte Blanche',
        '007': 'JCB',
        '042': 'Maestro',
        '062': 'China UnionPay',
        '036': 'CartesBancaires',
        '054': 'Elo',
        '046': 'JCrew',
        '070': 'EFTPOS',
        '067': 'Meeza',
        '060': 'Mada',
        '058': 'Carnet',
        '081': 'Jaywan'
    };

    if (cardTypeMap[cardTypeCode]) {
        return cardTypeMap[cardTypeCode];
    }

    var upperCode = cardTypeCode.toString().toUpperCase();
    var nameMap = {
        'VISA': 'Visa',
        'MASTERCARD': 'Master Card',
        'MASTER CARD': 'Master Card',
        'AMEX': 'Amex',
        'AMERICAN EXPRESS': 'Amex',
        'DISCOVER': 'Discover',
        'JCB': 'JCB',
        'DINERS': 'DinersClub',
        'DINERSCLUB': 'DinersClub',
        'MAESTRO': 'Maestro',
        'UNIONPAY': 'China UnionPay'
    };

    return nameMap[upperCode] || cardTypeCode;
}

// ============================================================================
// JWT Decoding Functions
// ============================================================================

/**
 * Decode JWT payload (base64url decode)
 * @param {string} token - JWT token string
 * @returns {Object|null} - Decoded payload or null if invalid
 */
function decodeJwtPayload(token) {
    if (!token || typeof token !== 'string') return null;
    try {
        var parts = token.split('.');
        if (parts.length !== 3) return null;
        var base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        var StringUtils = require('dw/util/StringUtils');
        var jsonPayload = decodeURIComponent(
            StringUtils.decodeBase64(base64).split('').map(function (c) {
                return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
            }).join('')
        );
        return JSON.parse(jsonPayload);
    } catch (e) {
        logger.warn('Failed to decode JWT payload: {0}', e.message);
        return null;
    }
}

// ============================================================================
// Payment Method Detection Functions
// ============================================================================

// Prefix of the processingInformation.paymentSolution string CyberSource returns for
// PPRO online bank-transfer APMs on the completeMandate result JWT - e.g.
// 'BankTransfer Payment Ideal' (iDEAL), 'BankTransfer Payment Multibanco' (Multibanco).
// These carry no paymentType descriptor, so this prefix is what identifies them. They
// are NOT card payments even though the scheme code is echoed into card.type.
var BANK_TRANSFER_PAYMENT_SOLUTION_PREFIX = 'BankTransfer Payment';


var UC_PAYMENT_TYPE_TO_METHOD = {
    PANENTRY: 'CREDIT_CARD',
    CHECK: 'BANK_TRANSFER',
    PAYPAL: 'PAYPAL',
    VENMO: 'VENMO',
    PAZE: 'DW_PAZE',
    IDEAL: 'ALT_PAYMENT_METHOD',
    BANCONTACT: 'ALT_PAYMENT_METHOD',
    MULTIBANCO: 'ALT_PAYMENT_METHOD',
    MYBANK: 'ALT_PAYMENT_METHOD',
    TINKPAYBYBANK: 'ALT_PAYMENT_METHOD',
    PRZELEWY24: 'ALT_PAYMENT_METHOD',
    P24: 'ALT_PAYMENT_METHOD',
    DRAGONPAY: 'ALT_PAYMENT_METHOD',
    KONBINI: 'ALT_PAYMENT_METHOD',
    // Wallet safety-net (primary path is the auth-JWT paymentSolution code).
    APPLEPAY: 'DW_APPLE_PAY',
    GOOGLEPAY: 'DW_GOOGLE_PAY',
    CLICKTOPAY: 'CLICK_TO_PAY'
};

/**
 * Resolve the SFCC payment method for an owned UC payment type (alternate payment
 * methods, eCheck, PayPal, Venmo) from the transient token's metadata.paymentType.
 *
 * Returns null - so the caller defers to the result-JWT detection - when there is no
 * transient token, no paymentType, or the paymentType is not one we own (card / Google
 * Pay / Apple Pay / Click to Pay / PAN entry / Paze: different owners, unchanged).
 *
 * @param {string} transientToken - Transient token JWT from the SDK
 * @returns {string|null} - Logical payment method, or null to defer to result-JWT logic
 */
function resolveMethodFromTransient(transientToken) {
    if (!transientToken) {
        return null;
    }
    var payload = decodeJwtPayload(transientToken);
    var paymentType = payload && payload.metadata && payload.metadata.paymentType;
    if (!paymentType) {
        return null;
    }
    return UC_PAYMENT_TYPE_TO_METHOD[paymentType.toString().toUpperCase()] || null;
}

/**
 * Detect payment method from completeMandate JWT.
 *
 * Order of checks:
 * 1. paymentInformation.bank present → BANK_TRANSFER (eCheck has no paymentSolution code)
 * 2. transient-token metadata.paymentType → owned methods (alternate payment methods,
 *    eCheck, PayPal, Venmo) via UC_PAYMENT_TYPE_TO_METHOD. The single, uniform signal for
 *    everything owned here; returns null (defer) for card / wallet / Click to Pay.
 * 3. alternate payment method (getApmDescriptor, result JWT) → ALT_PAYMENT_METHOD —
 *    fallback when the transient token is absent.
 * 4. processingInformation.paymentSolution code → DW_GOOGLE_PAY / DW_APPLE_PAY / CLICK_TO_PAY
 * 5. Default → CREDIT_CARD
 *
 * @param {Object} jwtPayload - Decoded completeMandate JWT payload
 * @param {string} [transientToken] - Transient token JWT from the SDK; the primary signal
 *        for the alternate payment methods / eCheck / PayPal / Venmo.
 * @returns {string} - Payment method ID
 */
function detectPaymentMethod(jwtPayload, transientToken) {
    var details = jwtPayload && jwtPayload.details;
    var paymentInfo = details && details.paymentInformation;

    // eCheck/ACH first: a bank object means ACH, never a redirect bank-transfer APM.
    // NOTE: PPRO online bank transfers (iDEAL, Bancontact, Multibanco, ...) do NOT
    // populate paymentInformation.bank in real payloads - they are identified by
    // paymentType below. (If a live PPRO result is ever found to populate .bank, add a
    // routingNumber guard here so only true eCheck maps to BANK_TRANSFER.)
    if (paymentInfo && paymentInfo.bank) {
        return 'BANK_TRANSFER';
    }

    // Alternate payment methods carry details.paymentInformation.paymentType.
    var altMethod = resolveMethodFromTransient(transientToken);
    if (altMethod) {
        return altMethod;
    }

    // Fallback (transient token absent / unmapped): the result JWT's
    // details.paymentInformation.paymentType. Owned APMs normally resolve from the
    // transient token in step 2 above; this only runs when that signal is missing.
    // Validated against real payloads: iDEAL {name:'ppro',type:'bank transfer',
    // method:'IDLPP'}, Multibanco {method:'MLTBT'}, AFFIRM {name:'INVOICE',
    // method:{name:'AFFIRM'}}. Cards and wallets never carry paymentType. This is
    // checked BEFORE the card branch because real APM payloads ALSO echo the scheme code
    // into paymentInformation.card.type (e.g. 'IDLPP'/'MLTBT'), misread as a card otherwise.
    var apm = getApmDescriptor(jwtPayload);
    if (apm) {
        // eWallet APMs with dedicated routes: PayPal, Venmo. paymentType.name is
        // 'eWallet' and method.name is 'payPal' or 'venmo' (case varies). Other
        // eWallets (e.g. Paze pending real-payload confirmation) fall through to
        // the generic ALT_PAYMENT_METHOD bucket below.
        if ((apm.name || '').toLowerCase() === 'ewallet') {
            var methodLower = (apm.method || '').toLowerCase();
            if (methodLower === 'paypal') return 'PAYPAL';
            if (methodLower === 'venmo') return 'VENMO';
        }
        // All other APMs (iDEAL, Multibanco, Bancontact, MyBank, P24, DragonPay,
        // Tink, Afterpay, Konbini, ...) are routed through one generic processor;
        // the scheme is recorded from getApmDescriptor by the alt_payment hook.
        return 'ALT_PAYMENT_METHOD';
    }


    var processingInfo = details && details.processingInformation;
    var paymentSolution = processingInfo && processingInfo.paymentSolution;

    if (paymentSolution === '012') {
        return 'DW_GOOGLE_PAY';
    } else if (paymentSolution === '001') {
        return 'DW_APPLE_PAY';
    } else if (paymentSolution === '027') {
        return 'CLICK_TO_PAY';
    }


    // Card present (PAN entry / tokenized saved card / wallet-backed card).
    if (paymentInfo && (paymentInfo.card || paymentInfo.tokenizedCard)) {
        return 'CREDIT_CARD';
    }

    // Resilience fallback: an unknown non-card paymentSolution with no card -> APM
    if (paymentSolution) {
        return 'ALT_PAYMENT_METHOD';
    }

    return 'CREDIT_CARD';
}


/**
 * Extract the alternate-payment-method descriptor from a completeMandate JWT.
 *
 * Two cases:
 * 1. An explicit details.paymentInformation.paymentType descriptor (BNPL, Tink, etc.).
 *    method is normalized whether it is a string (e.g. 'IDLPP') or an object
 *    (e.g. { name: 'AFFIRM' }).
 * 2. PPRO bank transfers (iDEAL, Multibanco, ...): the real result JWT has NO
 *    paymentType - they are identified by the processingInformation.paymentSolution
 *    string starting with 'BankTransfer Payment' (e.g. 'BankTransfer Payment Ideal',
 *    'BankTransfer Payment Multibanco'), and the scheme code ('IDLPP'/'MLTBT') is read
 *    from paymentInformation.card.type. These are NOT card payments.
 * 3. Bare result JWT (e.g. Tink Pay by Bank): the result JWT has no payment data, so
 *    the scheme is taken from the transient token - metadata.paymentType (e.g.
 *    'TINKPAYBYBANK') as the method, and content.paymentInformation.paymentType.name
 *    as the descriptor name.
 *
 * @param {Object} jwtPayload - Decoded completeMandate JWT payload
 * @param {string} [transientToken] - Transient token JWT from the SDK; used for Case 3
 *        when the result JWT carries no payment-type information.
 * @returns {Object|null} - { name, method } both strings, or null for a card/wallet
 */
function getApmDescriptor(jwtPayload, transientToken) {
    var details = jwtPayload && jwtPayload.details;
    var paymentInfo = details && details.paymentInformation;

    // Case 1: explicit paymentType descriptor.
    var paymentType = paymentInfo && paymentInfo.paymentType;
    if (paymentType) {
        var name = paymentType.name || '';
        var method = '';
        if (paymentType.method) {
            method = (typeof paymentType.method === 'string') ? paymentType.method : (paymentType.method.name || '');
        }
        if (name || method) {
            return { name: name, method: method };
        }
    }

    // Case 2: PPRO bank transfers (iDEAL, Multibanco, ...) - no paymentType, identified
    // by the 'BankTransfer Payment ...' paymentSolution string.
    var processingInfo = details && details.processingInformation;
    var paymentSolution = processingInfo && processingInfo.paymentSolution;
    if (typeof paymentSolution === 'string' && paymentSolution.indexOf(BANK_TRANSFER_PAYMENT_SOLUTION_PREFIX) === 0) {
        var schemeCode = (paymentInfo && paymentInfo.card && paymentInfo.card.type) || '';
        return { name: paymentSolution, method: schemeCode };
    }

    // Case 3: bare result JWT (e.g. Tink Pay by Bank). The scheme lives in the
    // transient token: metadata.paymentType is the specific code (e.g. 'TINKPAYBYBANK'),
    // content.paymentInformation.paymentType.name is the category label (e.g. 'INVOICE').
    if (transientToken) {
        var transientPayload = decodeJwtPayload(transientToken);
        var transientMethod = (transientPayload && transientPayload.metadata && transientPayload.metadata.paymentType) || '';
        if (transientMethod && transientMethod.toString().toUpperCase() !== 'CARD') {
            var contentPaymentInfo = transientPayload.content && transientPayload.content.paymentInformation;
            var contentPaymentType = contentPaymentInfo && contentPaymentInfo.paymentType && contentPaymentInfo.paymentType.name;
            var transientName = (contentPaymentType && (contentPaymentType.value || contentPaymentType)) || '';
            return { name: transientName || transientMethod, method: transientMethod };
        }
    }

    return null;
}

/**
 * Resolve a customer-facing display name for an alternate payment method, used on the
 * confirmation / email payment section. Maps the scheme code (e.g. 'IDLPP') to a clean
 * brand name (e.g. 'iDEAL'); falls back to the descriptor name, then the raw code.
 *
 * @param {Object} apmDescriptor - { name, method } from getApmDescriptor
 * @returns {string} - Display name (e.g. 'iDEAL')
 */
function getApmDisplayName(apmDescriptor) {
    var displayNames = {
        // Legacy JWT scheme codes (fallback path).
        IDLPP: 'iDEAL',
        MLTBT: 'Multibanco',
        // UC transient-token metadata.paymentType vocabulary (primary path).
        IDEAL: 'iDEAL',
        BANCONTACT: 'Bancontact',
        MULTIBANCO: 'Multibanco',
        MYBANK: 'MyBank',
        TINKPAYBYBANK: 'Tink Pay By Bank',
        PRZELEWY24: 'Przelewy24',
        P24: 'Przelewy24',
        DRAGONPAY: 'DragonPay',
        KONBINI: 'Konbini',
        PAZE: 'Paze',
        PAYPAL: 'PayPal',
        VENMO: 'Venmo'
    };
    if (!apmDescriptor) {
        return 'Alternate Payment';
    }
    var code = (apmDescriptor.method || '').toString().toUpperCase();
    if (displayNames[code]) {
        return displayNames[code];
    }
    return apmDescriptor.name || apmDescriptor.method || 'Alternate Payment';
}


// Logical method key (returned by detectPaymentMethod) -> processor ID used in
// the hook name 'app.payment.processor.<id>'. The processor IDs below match
// the hook entries registered in int_cybs_sfra_base/hooks.json. Authoritative
// source for routing is the JWT, not the BM PaymentMethod -> PaymentProcessor
// binding.
var METHOD_TO_PROCESSOR_ID = {
    CREDIT_CARD: 'payments_credit',
    BANK_TRANSFER: 'bank_transfer',
    DW_APPLE_PAY: 'payments_applepay',
    DW_GOOGLE_PAY: 'payments_googlepay',
    CLICK_TO_PAY: 'payments_click_to_pay',
    PAYPAL: 'payments_paypal',
    VENMO: 'payments_venmo',
    ALT_PAYMENT_METHOD: 'alt_payment'
};

/**
 * Resolve the processor hook key for a given logical payment method key.
 * @param {string} paymentMethodKey - Logical key from detectPaymentMethod (e.g. 'CREDIT_CARD', 'PAYPAL')
 * @returns {string|null} - Lower-cased processor ID for use in 'app.payment.processor.<id>', or null if unmapped
 */
function getProcessorIdForMethod(paymentMethodKey) {
    return METHOD_TO_PROCESSOR_ID[paymentMethodKey] || null;
}

/**
 * Extract bank details from a getPaymentDetails API response.
 * @param {Object} paymentDetails - Response from payments.getPaymentDetails(transientToken)
 * @param {Object} [billingAddress] - Optional billing address for accountHolder fallback
 * @returns {Object} - { routingNumber, accountNumber, accountHolder }
 */
function extractBankDetails(paymentDetails, billingAddress) {
    var bank = paymentDetails && paymentDetails.paymentInformation && paymentDetails.paymentInformation.bank;
    var routingNumber = bank && bank.routingNumber ? bank.routingNumber : '';
    var accountNumber = bank && bank.account && bank.account.number ? bank.account.number : '';
    var accountHolder = '';
    if (billingAddress && billingAddress.fullName) {
        accountHolder = billingAddress.fullName;
    }
    return {
        routingNumber: routingNumber,
        accountNumber: accountNumber,
        accountHolder: accountHolder
    };
}

// ============================================================================
// Card Details Extraction Functions
// ============================================================================

/**
 * Extract card details from completeMandate JWT and transient token
 * @param {Object} jwtPayload - Decoded completeMandate JWT payload
 * @param {string} transientToken - Transient token from SDK
 * @param {Object} billingAddress - Optional billing address object
 * @returns {Object} - Card details object
 */
function extractCardDetails(jwtPayload, transientToken, billingAddress) {
    var cardDetails = {
        cardTypeCode: '',
        cardTypeName: '',
        maskedNumber: '',
        expirationMonth: '',
        expirationYear: '',
        cardHolderName: ''
    };

    // Get cardholder name from billing address if provided
    if (billingAddress) {
        var firstName = billingAddress.firstName || '';
        var lastName = billingAddress.lastName || '';
        if (firstName || lastName) {
            cardDetails.cardHolderName = (firstName + ' ' + lastName).trim();
        }
    }

    // Get card type from completeMandate JWT
    if (jwtPayload.details && jwtPayload.details.paymentInformation) {
        var paymentInfoJwt = jwtPayload.details.paymentInformation;

        if (paymentInfoJwt.card && paymentInfoJwt.card.type) {
            cardDetails.cardTypeCode = paymentInfoJwt.card.type;
        }
        if (!cardDetails.cardTypeCode && paymentInfoJwt.tokenizedCard && paymentInfoJwt.tokenizedCard.type) {
            cardDetails.cardTypeCode = paymentInfoJwt.tokenizedCard.type;
        }

        if (paymentInfoJwt.tokenizedCard) {
            cardDetails.expirationMonth = paymentInfoJwt.tokenizedCard.expirationMonth || '';
            cardDetails.expirationYear = paymentInfoJwt.tokenizedCard.expirationYear || '';
        }
        if ((!cardDetails.expirationMonth || !cardDetails.expirationYear) && paymentInfoJwt.card) {
            cardDetails.expirationMonth = cardDetails.expirationMonth || paymentInfoJwt.card.expirationMonth || '';
            cardDetails.expirationYear = cardDetails.expirationYear || paymentInfoJwt.card.expirationYear || '';
        }
    }

    // Get details from transient token
    if (transientToken) {
        var transientPayload = decodeJwtPayload(transientToken);
        if (transientPayload && transientPayload.content && transientPayload.content.paymentInformation) {
            var transientPaymentInfo = transientPayload.content.paymentInformation;

            if (transientPaymentInfo.tokenizedCard && transientPaymentInfo.tokenizedCard.number) {
                var tokenizedNum = transientPaymentInfo.tokenizedCard.number;
                cardDetails.maskedNumber = tokenizedNum.maskedValue || tokenizedNum || '';
            }
            if (!cardDetails.maskedNumber && transientPaymentInfo.card && transientPaymentInfo.card.number) {
                var cardNum = transientPaymentInfo.card.number;
                cardDetails.maskedNumber = cardNum.maskedValue || cardNum || '';
            }

            if (!cardDetails.expirationMonth || !cardDetails.expirationYear) {
                if (transientPaymentInfo.card) {
                    var expMonth = transientPaymentInfo.card.expirationMonth;
                    var expYear = transientPaymentInfo.card.expirationYear;
                    cardDetails.expirationMonth = cardDetails.expirationMonth || (expMonth ? expMonth.value || expMonth : '');
                    cardDetails.expirationYear = cardDetails.expirationYear || (expYear ? expYear.value || expYear : '');
                }
                if (transientPaymentInfo.tokenizedCard) {
                    var tokExpMonth = transientPaymentInfo.tokenizedCard.expirationMonth;
                    var tokExpYear = transientPaymentInfo.tokenizedCard.expirationYear;
                    cardDetails.expirationMonth = cardDetails.expirationMonth || (tokExpMonth ? tokExpMonth.value || tokExpMonth : '');
                    cardDetails.expirationYear = cardDetails.expirationYear || (tokExpYear ? tokExpYear.value || tokExpYear : '');
                }
            }

            if (!cardDetails.cardTypeCode && transientPaymentInfo.card && transientPaymentInfo.card.type) {
                cardDetails.cardTypeCode = transientPaymentInfo.card.type.value || transientPaymentInfo.card.type || '';
            }
            if (!cardDetails.cardTypeCode && transientPaymentInfo.tokenizedCard && transientPaymentInfo.tokenizedCard.type) {
                cardDetails.cardTypeCode = transientPaymentInfo.tokenizedCard.type.value || transientPaymentInfo.tokenizedCard.type || '';
            }
        }
    }

    cardDetails.cardTypeName = mapCardType(cardDetails.cardTypeCode);
    return cardDetails;
}

/**
 * Build payment details string for display
 * @param {Object} cardDetails - Card details object
 * @returns {string} - Formatted payment details string
 */
function buildPaymentDetailsString(cardDetails) {
    if (cardDetails.maskedNumber && cardDetails.cardTypeName) {
        return cardDetails.maskedNumber + ', ' + cardDetails.cardTypeName;
    } else if (cardDetails.maskedNumber) {
        return cardDetails.maskedNumber;
    } else if (cardDetails.cardTypeName) {
        return cardDetails.cardTypeName;
    }
    return '';
}

/**
 * Update payment instrument with card details
 * @param {dw.order.PaymentInstrument} paymentInstrument - Payment instrument to update
 * @param {Object} cardDetails - Card details object
 * @param {boolean} isDigitalWallet - Whether payment is from Google Pay or Apple Pay
 */
function updatePaymentInstrumentCardDetails(paymentInstrument, cardDetails, isDigitalWallet) {
    if (cardDetails.cardHolderName && (isDigitalWallet || !paymentInstrument.creditCardHolder)) {
        paymentInstrument.setCreditCardHolder(cardDetails.cardHolderName);
    }
    if (cardDetails.maskedNumber && (isDigitalWallet || !paymentInstrument.creditCardNumber)) {
        paymentInstrument.setCreditCardNumber(cardDetails.maskedNumber);
    }
    if (cardDetails.cardTypeName && (isDigitalWallet || !paymentInstrument.creditCardType)) {
        paymentInstrument.setCreditCardType(cardDetails.cardTypeName);
    }
    if (cardDetails.expirationMonth && (isDigitalWallet || !paymentInstrument.creditCardExpirationMonth)) {
        paymentInstrument.setCreditCardExpirationMonth(parseInt(cardDetails.expirationMonth, 10));
    }
    if (cardDetails.expirationYear && (isDigitalWallet || !paymentInstrument.creditCardExpirationYear)) {
        paymentInstrument.setCreditCardExpirationYear(parseInt(cardDetails.expirationYear, 10));
    }
}

// ============================================================================
// Transaction Custom Attribute Functions
// ============================================================================

/**
 * Safely set custom attribute on payment transaction
 * @param {dw.order.PaymentTransaction} paymentTransaction - Payment transaction
 * @param {string} attributeName - Custom attribute name
 * @param {*} value - Value to set
 * @returns {boolean} - True if attribute was set
 */
function setTransactionCustomAttribute(paymentTransaction, attributeName, value) {
    if (!value) return false;
    try {
        if (attributeName in paymentTransaction.custom) {
            paymentTransaction.custom[attributeName] = value;
            return true;
        }
    } catch (e) {
        logger.debug('Custom attribute {0} not available on PaymentTransaction', attributeName);
    }
    return false;
}


/**
 * Safely set a custom attribute on a payment instrument. Mirrors
 * setTransactionCustomAttribute - no-ops (without throwing) when the attribute is not
 * defined in the system-object metadata, so alternate-payment-method recording does
 * not fail an order in an environment where the metadata has not been imported yet.
 *
 * @param {dw.order.PaymentInstrument} paymentInstrument - Payment instrument
 * @param {string} attributeName - Custom attribute name
 * @param {*} value - Value to set
 * @returns {boolean} - True if attribute was set
 */
function setInstrumentCustomAttribute(paymentInstrument, attributeName, value) {
    if (!value) return false;
    try {
        if (attributeName in paymentInstrument.custom) {
            paymentInstrument.custom[attributeName] = value;
            return true;
        }
    } catch (e) {
        logger.debug('Custom attribute {0} not available on PaymentInstrument', attributeName);
    }
    return false;
}


// ============================================================================
// Authorization Status Functions
// ============================================================================

/**
 * Check if authorization/capture status is valid for order placement
 * Handles both AUTH and CAPTURE (sale) transaction types
 * 
 * AUTH statuses:
 * - AUTHORIZED: Authorization successful
 * - AUTHORIZED_PENDING_REVIEW: Authorization successful, pending fraud review
 * 
 * CAPTURE (sale) statuses:
 * - CAPTURED: Capture/sale successful
 * - PARTIAL_CAPTURED: Partial capture successful
 * - PENDING: Transaction pending (some capture flows)
 *
 * PENDING is also the normal terminal state for asynchronous/redirect alternate
 * payment methods (PPRO bank transfers, some BNPL). The order is placed but left
 * NOTCONFIRMED and reconciled later by the webhook (WebhookNotification) when the
 * provider settles - SFCC has no request-time async to poll status here.
 *
 * @param {string} status - Status from completeMandate JWT
 * @returns {boolean} - True if status is valid for order placement
 */
function isValidAuthorizationStatus(status) {
    var validStatuses = [
        // AUTH statuses
        'AUTHORIZED',
        'AUTHORIZED_PENDING_REVIEW',
        // CAPTURE (sale) statuses
        'CAPTURED',
        'PARTIAL_CAPTURED',
        'PENDING',

        // Alternate payment method (PPRO / BNPL) non-decline outcomes. Validated
        // against real payloads: iDEAL/Multibanco -> PENDING, Tink -> SETTLE_INITIATED,
        // AFFIRM -> AUTHORIZED / PENDING / COMPLETED. PENDING and SETTLE_INITIATED
        // orders are placed NOTCONFIRMED and reconciled by the webhook;
        // COMPLETED / SETTLED are already settled. Cards never use these statuses, so
        // there is no card-flow regression.
        'COMPLETED',
        'SETTLED',
        'SETTLE_INITIATED'

    ];
    return validStatuses.indexOf(status) !== -1;
}

/**
 * Get error message based on authorization status
 * @param {string} status - Authorization status
 * @returns {string} - Error message
 */
function getAuthorizationErrorMessage(status) {
    var Resource = require('dw/web/Resource');
    if (status === 'DECLINED') {
        return Resource.msg('error.payment.declined', 'error', null);
    } else if (status === 'AUTHORIZED_RISK_DECLINED') {
        return Resource.msg('error.payment.risk.declined', 'error', null);
    }
    return Resource.msg('message.error.card.not.authorized', 'error', null);
}

// ============================================================================
// Capture Context Builder Functions
// ============================================================================

/**
 * Build billTo object from basket billing address
 * @param {dw.order.Basket} basket - Current basket
 * @returns {Object|null} - billTo object or null
 */
function buildBillToAddress(basket) {
    var billingAddress = basket.billingAddress;
    if (!billingAddress) return null;

    // UC v1 (ISV Phase 1): match the canonical billTo shape from Dan's reference payload —
    // firstName, lastName, email, address1, address2, locality, administrativeArea, postalCode,
    // country, phoneNumber, phoneType.
    var billTo = {
        firstName: billingAddress.firstName || '',
        lastName: billingAddress.lastName || '',
        email: basket.customerEmail || '',
        address1: billingAddress.address1 || '',
        address2: billingAddress.address2 || '',
        locality: billingAddress.city || '',
        administrativeArea: billingAddress.stateCode || '',
        postalCode: billingAddress.postalCode || '',
        country: billingAddress.countryCode ? billingAddress.countryCode.value.toUpperCase() : '',
        phoneNumber: billingAddress.phone || ''
    };
    return billTo;
}

/**
 * Build a UC billTo object from a customer Address Book entry.
 * Used by the My Account save-card flow to prefill the Unified Checkout billing form.
 * @param {dw.customer.CustomerAddress} customerAddress - source address (preferred or first)
 * @param {string} email - customer profile email
 * @returns {Object|null} billTo object, or null when no address
 */
function buildBillToFromCustomerAddress(customerAddress, email) {
    if (!customerAddress) return null;

    return {
        firstName: customerAddress.firstName || '',
        lastName: customerAddress.lastName || '',
        email: email || '',
        address1: customerAddress.address1 || '',
        address2: customerAddress.address2 || '',
        locality: customerAddress.city || '',
        administrativeArea: customerAddress.stateCode || '',
        postalCode: customerAddress.postalCode || '',
        country: customerAddress.countryCode && customerAddress.countryCode.value
            ? customerAddress.countryCode.value.toUpperCase() : '',
        phoneNumber: customerAddress.phone || ''
    };
}

/**
 * Build a cardholder display name ("First Last") from a billTo object.
 * Tolerates a missing/partial billTo so callers can pass any of the UC billTo
 * sources (completeMandate JWT, transient-token transaction) directly.
 * @param {Object} billTo - billTo object with firstName/lastName (may be null/partial)
 * @returns {string} trimmed "First Last", or '' when no name is present
 */
function buildCardHolderName(billTo) {
    if (!billTo) return '';
    var firstName = billTo.firstName || '';
    var lastName = billTo.lastName || '';
    return (firstName + ' ' + lastName).trim();
}

/**
 * Build shipTo object from basket shipping address
 * @param {dw.order.Basket} basket - Current basket
 * @returns {Object|null} - shipTo object or null
 */
function buildShipToAddress(basket) {
    var defaultShipment = basket.defaultShipment;
    var shippingAddress = defaultShipment ? defaultShipment.shippingAddress : null;
    if (!shippingAddress) return null;

    // UC v1 (ISV Phase 1): match Dan's reference payload — shipTo carries the address and
    // recipient name only. No phoneNumber, no email.
    return {
        firstName: shippingAddress.firstName || '',
        lastName: shippingAddress.lastName || '',
        address1: shippingAddress.address1 || '',
        address2: shippingAddress.address2 || '',
        locality: shippingAddress.city || '',
        administrativeArea: shippingAddress.stateCode || '',
        postalCode: shippingAddress.postalCode || '',
        country: shippingAddress.countryCode ? shippingAddress.countryCode.value.toUpperCase() : ''
    };
}

/**
 * Get the number of decimal places for a currency from BM configuration
 * Uses SFCC Currency API which reads from BM > Merchant Tools > Ordering > Currencies
 * @param {string} currencyCode - ISO 4217 currency code
 * @returns {number} - Number of decimal places (0, 2, or 3)
 */
function getCurrencyDecimalPlaces(currencyCode) {
    if (!currencyCode) return 2;

    var Currency = require('dw/util/Currency');

    try {
        var currency = Currency.getCurrency(currencyCode);
        if (currency) {
            return currency.getDefaultFractionDigits();
        }
    } catch (e) {
        logger.warn('getCurrencyDecimalPlaces: Error getting currency {0} - {1}', currencyCode, e.message);
    }

    // Default fallback if currency not found in BM
    return 2;
}

/**
 * Format amount with proper decimal places for currency
 * Uses BM currency configuration for decimal places (ISO 4217 compliant)
 * @param {number} amount - Amount value
 * @param {string} [currencyCode] - ISO 4217 currency code (defaults to 2 decimals if not provided)
 * @returns {string} - Formatted amount string
 */
function formatAmount(amount, currencyCode) {
    var decimals = getCurrencyDecimalPlaces(currencyCode);

    if (amount === null || amount === undefined) {
        return decimals === 0 ? '0' : Number(0).toFixed(decimals);
    }

    return decimals === 0 ? String(Math.round(Number(amount))) : Number(amount).toFixed(decimals);
}

/**
 * Build line items array from basket for capture context
 * @param {dw.order.Basket} basket - Current basket
 * @returns {Array} - Array of line item objects
 */
function buildLineItems(basket) {
    var lineItems = [];
    var allLineItems = basket.allLineItems;
    var currencyCode = basket.currencyCode;

    if (!allLineItems) return lineItems;

    for (var i = 0; i < allLineItems.length; i++) {
        var lineItem = allLineItems[i];
        var itemObject = null;

        // All line amounts are NET (tax-exclusive). Tax is sent separately in taxAmount.
        // amountDetails.totalAmount is the GROSS basket total, so:
        //   sum(line totalAmount) + sum(line taxAmount) === amountDetails.totalAmount.
        // Sending a gross (tax-inclusive) totalAmount here while ALSO sending taxAmount
        // double-counts tax, the totals stop reconciling, and wallets/APMs (PayPal, Venmo,
        // Google Pay) silently refuse to render. Only a zero-tax basket happened to work.
        if (lineItem instanceof dw.order.ProductLineItem) {
            // UC v1 (ISV Phase 1): canonical line-item shape. typeOfSupply '00' = goods.
            var product = lineItem.product;
            var productDescription = '';
            if (product && product.shortDescription) {
                productDescription = product.shortDescription.markup || '';
            }
            if (!productDescription) {
                productDescription = lineItem.productName || '';
            }
            itemObject = {
                productSku: lineItem.productID || '',
                productName: lineItem.productName || '',
                productDescription: productDescription,
                quantity: lineItem.quantityValue,
                unitPrice: formatAmount(lineItem.basePrice.value, currencyCode),
                totalAmount: formatAmount(lineItem.adjustedGrossPrice.value, currencyCode),
                typeOfSupply: '00',
                taxAmount: formatAmount(lineItem.adjustedTax.value > 0 ? lineItem.adjustedTax.value : 0, currencyCode)
            };
        } else if (lineItem instanceof dw.order.GiftCertificateLineItem) {
            // typeOfSupply '00' = goods.
            itemObject = {
                productSku: 'GIFT_CERTIFICATE',
                productName: 'GIFT_CERTIFICATE',
                productDescription: 'GIFT_CERTIFICATE',
                quantity: 1,
                unitPrice: formatAmount(lineItem.adjustedPrice.value, currencyCode),
                totalAmount: formatAmount(lineItem.adjustedGrossPrice.value, currencyCode),
                typeOfSupply: '00',
                taxAmount: formatAmount(0, currencyCode)
            };
        } else if (lineItem instanceof dw.order.ShippingLineItem) {
            if (lineItem.adjustedPrice.value === 0) {
                continue;
            }
            // typeOfSupply '01' = shipping/services.
            itemObject = {
                productSku: lineItem.ID || 'SHIPPING',
                productName: lineItem.ID || 'SHIPPING',
                productDescription: 'SHIPPING',
                quantity: 1,
                unitPrice: formatAmount(lineItem.adjustedPrice.value, currencyCode),
                totalAmount: formatAmount(lineItem.adjustedGrossPrice.value, currencyCode),
                typeOfSupply: '01'
            };
        } else if (lineItem instanceof dw.order.ProductShippingLineItem) {
            // typeOfSupply '01' = shipping/services.
            itemObject = {
                productSku: 'SHIPPING_SURCHARGE',
                productName: 'SHIPPING_SURCHARGE',
                productDescription: 'SHIPPING_SURCHARGE',
                quantity: 1,
                unitPrice: formatAmount(lineItem.adjustedPrice.value, currencyCode),
                totalAmount: formatAmount(lineItem.adjustedGrossPrice.value, currencyCode),
                typeOfSupply: '01',
                taxAmount: formatAmount(lineItem.adjustedTax ? lineItem.adjustedTax.value : 0, currencyCode)
            };
        }

        if (itemObject) {
            lineItems.push(itemObject);
        }
    }

    return lineItems;
}

/**
 * Build completeMandate object based on configuration
 * 
 * UC v1: Only TMS tokenTypes configuration is passed.
 * Other configuration (type, decisionManager, tms.tokenCreate, consumerAuthentication)
 * is managed via EBC (Enterprise Business Center) and should NOT be overridden.
 * 
 * Available tokenTypes:
 * - customer: Creates a TMS customer token
 * - paymentInstrument: Creates a payment instrument token
 * - instrumentIdentifier: Creates an instrument identifier token
 * - shippingAddress: Creates a shipping address token
 * 
 * @param {Object} configObject - Configuration object from BM (unused in UC v1)
 * @param {boolean} isTokenizationEnabled - Whether tokenization is enabled (unused in UC v1)
 * @param {boolean} isRegisteredCustomer - Whether customer is registered (unused in UC v1)
 * @param {dw.customer.Customer} customer - Customer object (unused in UC v1)
 * @returns {Object} - completeMandate object with TMS tokenTypes
 */
function buildCompleteMandate(configObject, isTokenizationEnabled, isRegisteredCustomer, customer) {
    // UC v1: Return completeMandate with TMS tokenTypes
    // tokenTypes specifies which tokens to create when cardholder opts to save card
    return {
        tms: {
            tokenTypes: ['customer', 'paymentInstrument', 'instrumentIdentifier']
        }
    };
}

/**
 * Build transientTokenResponseOptions for the UC capture context, honoring the
 * VisaAcceptance_UnifiedCheckout_AllowedCardPrefix preference (BIN return mode):
 *   'None'  -> includeCardPrefix: false  (no BIN in the transient token)
 *   'Six'   -> field omitted entirely    (CyberSource defaults to a 6-digit BIN)
 *   'Eight' -> includeCardPrefix: true   (8-digit BIN)
 * Any other or legacy value (including a leftover boolean from the old toggle) is
 * treated as 'None'.
 * @param {Object} configObject - resolved configuration (configuration/index)
 * @returns {Object} - transientTokenResponseOptions object for the capture-context request
 */
function buildTransientTokenResponseOptions(configObject) {
    var mode = configObject && configObject.unifiedCheckoutAllowedCardPrefix;
    if (mode === 'Six') {
        // Omit includeCardPrefix so CyberSource returns the default 6-digit BIN.
        return {};
    }
    if (mode === 'Eight') {
        return { includeCardPrefix: true };
    }
    // 'None' (default) and any unexpected/legacy value: suppress the BIN.
    return { includeCardPrefix: false };
}

/**
 * Build orderInformation object for capture context
 * @param {dw.order.Basket} basket - Current basket
 * @returns {Object} - orderInformation object
 */
function buildOrderInformation(basket) {
    var currencyCode = basket.currencyCode;
    // UC v1 (ISV Phase 1): mirror canonical amountDetails — totalAmount, currency, taxAmount.
    var totalTax = basket.totalTax && basket.totalTax.value > 0 ? basket.totalTax.value : 0;
    var orderInformation = {
        amountDetails: {
            totalAmount: formatAmount(basket.totalGrossPrice.value, currencyCode),
            currency: currencyCode,
            taxAmount: formatAmount(totalTax, currencyCode)
        }
    };

    // Populate billTo/shipTo whenever the basket has them, for both checkout and
    // Express Pay flows, so the capture-context mirrors the data CyberSource needs to
    // render APMs and wallets. The build helpers return null when no address exists.
    var billTo = buildBillToAddress(basket);
    if (billTo) {
        orderInformation.billTo = billTo;
    }

    var shipTo = buildShipToAddress(basket);
    if (shipTo) {
        orderInformation.shipTo = shipTo;
    }

    var lineItems = buildLineItems(basket);
    if (lineItems.length > 0) {
        orderInformation.lineItems = lineItems;
    }

    return orderInformation;
}

// ============================================================================
// TMS Token Saving Functions
// ============================================================================

/**
 * Resolve the existing CyberSource TMS customer token id stored on the customer's
 * profile (Profile.custom.customerID). This is the id used to attach newly-saved
 * cards to a single customer instead of minting a new customer per card.
 * @param {dw.customer.Customer} customer - customer object
 * @returns {string|null} the stored customerID, or null when absent / not resolvable
 */
function getExistingTmsCustomerId(customer) {
    if (!customer || typeof customer.getProfile !== 'function') {
        return null;
    }
    var profile = customer.getProfile();
    if (!profile || !profile.custom || !profile.custom.customerID) {
        return null;
    }
    return profile.custom.customerID;
}

/**
 * Build the completeMandate.tms.tokenTypes array for a UC capture context.
 * When the account already has a TMS customer token, the 'customer' type is
 * omitted so CyberSource attaches the new instrument under the existing customer
 * (mirrors the Non-UC actionTokenTypes behavior). When there is no customer yet
 * (first saved card), 'customer' is requested so CyberSource mints one.
 * @param {string|null} existingCustomerId - stored Profile.custom.customerID, or null
 * @returns {string[]} tokenTypes array
 */
function buildTmsTokenTypes(existingCustomerId) {
    if (existingCustomerId) {
        return ['paymentInstrument', 'instrumentIdentifier'];
    }
    return ['customer', 'paymentInstrument', 'instrumentIdentifier'];
}

/**
 * Build the serialized wallet token string stored in CustomerPaymentInstrument.creditCardToken.
 * Format: "<instrumentIdentifierId>-<paymentInstrumentId>-flex[-<customerId>]".
 * The '-flex-' marker is intentional and shared with Unified Checkout (do not strip it).
 * @param {string} instrumentIdentifierId - CyberSource instrumentIdentifier id
 * @param {string} paymentInstrumentId - CyberSource paymentInstrument id
 * @param {string|null} customerId - TMS customer id to append, or falsy to omit
 * @returns {string} serialized token
 */
function buildSerializedToken(instrumentIdentifierId, paymentInstrumentId, customerId) {
    var segments = [instrumentIdentifierId, paymentInstrumentId, 'flex'];
    if (customerId) {
        segments.push(customerId);
    }
    return segments.join('-');
}

/**
 * Check if user opted to save card in UC completeMandate response
 * @param {Object} jwtPayload - Decoded completeMandate JWT payload
 * @returns {boolean} - True if tokenInformation exists
 */
function didUserRequestSaveCard(jwtPayload) {
    return !!(jwtPayload.details && jwtPayload.details.tokenInformation);
}

/**
 * Extract token information from completeMandate JWT response
 * @param {Object} jwtPayload - Decoded completeMandate JWT payload
 * @returns {Object|null} - Token information object or null
 */
function extractTokenInformation(jwtPayload) {
    if (!jwtPayload.details || !jwtPayload.details.tokenInformation) {
        return null;
    }
    return jwtPayload.details.tokenInformation;
}

/**
 * Find an existing saved credit card that belongs to the given CyberSource
 * instrumentIdentifier. The serialized token always begins with the
 * instrumentIdentifier id ("<iid>-<piid>-flex[-<customerId>]"), so a card matches
 * when the FIRST hyphen-separated segment of its token equals that id. Using the
 * exact segment (rather than a string prefix) avoids false matches between ids where
 * one is a prefix of another.
 * @param {dw.customer.Wallet} wallet - customer wallet
 * @param {string} instrumentIdentifierId - CyberSource instrumentIdentifier id
 * @returns {dw.customer.CustomerPaymentInstrument|null} matching card or null
 */
function findCreditCardByInstrumentIdentifier(wallet, instrumentIdentifierId) {
    if (!wallet || !instrumentIdentifierId) {
        return null;
    }
    var paymentInstruments = wallet.getPaymentInstruments().toArray();
    for (var i = 0; i < paymentInstruments.length; i++) {
        var pi = paymentInstruments[i];
        var existingToken = pi.creditCardToken;
        if (existingToken && existingToken.split('-')[0] === instrumentIdentifierId) {
            return pi;
        }
    }
    return null;
}

/**
 * Saves a tokenized credit card to the wallet, de-duplicating by instrumentIdentifier.
 *
 * SFCC permanently masks a persisted CustomerPaymentInstrument; once masked, its card
 * setters throw "Payment Instrument Info attributes are already masked permanently". So
 * when a card with the same instrumentIdentifier already exists we REPLACE it (create a
 * fresh instrument, then remove the old one) inside a single transaction — rather than
 * mutating the masked record — carrying over any missing details and the default
 * (custom.isDefault) flag.
 *
 * @param {dw.customer.Wallet} wallet - customer wallet
 * @param {string} serializedToken - serialized TMS token to store
 * @param {Object} cardDetails - { cardHolderName, cardTypeName, maskedNumber, expirationMonth, expirationYear }
 * @param {string} instrumentIdentifierId - CyberSource instrumentIdentifier id
 * @returns {Object} { uuid: <saved card UUID>, replacedExisting: <boolean> }
 */
function upsertCreditCard(wallet, serializedToken, cardDetails, instrumentIdentifierId) {
    var dwOrderPaymentInstrument = require('dw/order/PaymentInstrument');
    var details = cardDetails || {};
    var existingPI = findCreditCardByInstrumentIdentifier(wallet, instrumentIdentifierId);

    var wasDefault = false;
    var holder = details.cardHolderName;
    var type = details.cardTypeName;
    var masked = details.maskedNumber;
    var expMonth = details.expirationMonth;
    var expYear = details.expirationYear;

    if (existingPI) {
        // Getters are safe on a masked instrument; carry over anything the new details
        // don't provide so the replacement record stays complete.
        try {
            wasDefault = !!(existingPI.custom && existingPI.custom.isDefault);
        } catch (e) {
            wasDefault = false;
        }
        holder = holder || existingPI.creditCardHolder;
        type = type || existingPI.creditCardType;
        masked = masked || existingPI.maskedCreditCardNumber;
        expMonth = expMonth || existingPI.creditCardExpirationMonth;
        expYear = expYear || existingPI.creditCardExpirationYear;
    }

    var savedUUID = null;
    Transaction.wrap(function () {
        var newPI = wallet.createPaymentInstrument(dwOrderPaymentInstrument.METHOD_CREDIT_CARD);
        if (holder) { newPI.setCreditCardHolder(holder); }
        if (type) { newPI.setCreditCardType(type); }
        if (masked) { newPI.setCreditCardNumber(masked); }
        if (expMonth) { newPI.setCreditCardExpirationMonth(parseInt(expMonth, 10)); }
        if (expYear) { newPI.setCreditCardExpirationYear(parseInt(expYear, 10)); }
        newPI.setCreditCardToken(serializedToken);
        if (wasDefault) {
            newPI.custom.isDefault = true;
        }
        if (existingPI) {
            wallet.removePaymentInstrument(existingPI);
        }
        savedUUID = newPI.UUID;
    });

    return { uuid: savedUUID, replacedExisting: !!existingPI };
}

/**
 * Save TMS token to customer wallet from completeMandate response
 * @param {Object} jwtPayload - Decoded completeMandate JWT payload
 * @param {Object} cardDetails - Card details object
 * @param {dw.customer.Customer} customer - Customer object
 * @returns {boolean} - True if token was saved successfully
 */
function saveTokenToWallet(jwtPayload, cardDetails, customer) {
    if (!didUserRequestSaveCard(jwtPayload)) {
        logger.debug('saveTokenToWallet: User did not opt to save card');
        return false;
    }

    if (!customer || !customer.isAuthenticated() || !customer.getProfile()) {
        logger.debug('saveTokenToWallet: Customer not authenticated');
        return false;
    }

    var tokenInfo = extractTokenInformation(jwtPayload);
    if (!tokenInfo) {
        logger.debug('saveTokenToWallet: No token information in JWT response');
        return false;
    }

    if (!tokenInfo.paymentInstrument || !tokenInfo.paymentInstrument.id ||
        !tokenInfo.instrumentIdentifier || !tokenInfo.instrumentIdentifier.id) {
        logger.warn('saveTokenToWallet: Missing required token fields');
        return false;
    }

    var CustomerMgr = require('dw/customer/CustomerMgr');
    var TRLHelper = require('~/cartridge/scripts/helpers/tokenRateLimiterHelper.js');

    try {
        var profile = customer.getProfile();
        var customerObj = CustomerMgr.getCustomerByCustomerNumber(profile.customerNo);

        var isAllowed = TRLHelper.IsCustumerAllowedSinglePaymentInstrumentInsertion(customerObj);
        if (!isAllowed.result) {
            logger.warn('saveTokenToWallet: Rate limiter rejected');
            return false;
        }

        var wallet = customerObj.profile.wallet;

        // Prefer the customer id the response echoes; otherwise fall back to the id already
        // stored on the profile. Subsequent saves omit the 'customer' token type, so the
        // response may not echo customer.id, but the card still belongs to the stored customer.
        var responseCustomerId = (tokenInfo.customer && tokenInfo.customer.id) ? tokenInfo.customer.id : null;
        var effectiveCustomerId = responseCustomerId || profile.custom.customerID || null;

        var serializedToken = buildSerializedToken(
            tokenInfo.instrumentIdentifier.id,
            tokenInfo.paymentInstrument.id,
            effectiveCustomerId
        );

        // First card on the account: persist the freshly-minted customer id for future saves.
        if (responseCustomerId && !profile.custom.customerID) {
            Transaction.wrap(function () {
                profile.custom.customerID = responseCustomerId;
            });
        }

        var upsertResult = upsertCreditCard(wallet, serializedToken, cardDetails, tokenInfo.instrumentIdentifier.id);
        logger.info('saveTokenToWallet: Card {0}. InstrumentIdentifier: {1}',
            upsertResult.replacedExisting ? 'updated (replaced)' : 'saved', tokenInfo.instrumentIdentifier.id);

        // Only a brand-new card counts against the rate limiter (a replace is not a new insertion).
        if (!upsertResult.replacedExisting) {
            if (isAllowed.resetTimer) {
                TRLHelper.resetTimer(customerObj);
            }
            if (isAllowed.increaseCounter) {
                TRLHelper.increaseCounter(customerObj);
            }
        }

        return true;
    } catch (e) {
        logger.error('saveTokenToWallet: Error saving token - {0}', e.message || e);
        return false;
    }
}

// ============================================================================
// Shipping Method Helper Functions
// ============================================================================

/**
 * Set default shipping method on basket if not present
 * @param {dw.order.Basket} basket - Current basket
 * @param {Object} TransactionObj - DW Transaction object
 */
function setDefaultShippingMethod(basket, TransactionObj) {
    var ShippingMgr = require('dw/order/ShippingMgr');
    var shipment = basket.getDefaultShipment();

    if (!shipment.shippingMethod) {
        var defaultMethod = ShippingMgr.getDefaultShippingMethod();
        if (defaultMethod) {
            TransactionObj.wrap(function () {
                shipment.setShippingMethod(defaultMethod);
            });
            logger.info('setDefaultShippingMethod: Default shipping method set: {0}', defaultMethod.ID);
        }
    }
}

/**
 * Build deviceInformation object for Capture Context API
 * Per CyberSource documentation, the capture context deviceInformation only supports ipAddress.
 * Other device fields (httpAcceptContent, userAgentBrowserValue, deviceChannel, etc.) are meant
 * for 3DS payer authentication during payment authorization, not capture context generation.
 * 
 * @returns {Object} - deviceInformation object with ipAddress only
 */
function buildCaptureContextDeviceInformation() {
    return {
        ipAddress: request.httpRemoteAddress
    };
}

/**
 * Build consumerAuthenticationInformation object for Capture Context API
 * 
 * Handles SCA (Strong Customer Authentication) challenge code behavior:
 * - When an SCA-required outcome (e.g., response 478) occurred previously,
 *   challengeCode = '04' is included to mandate challenge on retry
 * - Default challengeCode is '01' (no preference) when payer auth is enabled
 * 
 * Challenge Code Values:
 * - 01: No preference (default)
 * - 04: Challenge mandated - SCA required
 * 
 * @param {Object} configObject - Configuration object from BM
 * @returns {Object|null} - consumerAuthenticationInformation object or null if payer auth is disabled
 */
function buildConsumerAuthenticationInformation(configObject) {
    // Check if payer authentication is enabled
    var payerAuthSetting = (configObject.payerAuthenticationEnabled || '').toString().toUpperCase();
    if (payerAuthSetting !== 'YES' && payerAuthSetting !== 'DATA_ONLY_YES' && payerAuthSetting !== 'DATA_ONLY_NO') {
        return null;
    }

    // Only return challengeCode if SCA was required (session flag set by failed auth)
    if (session.privacy.scaRequired) {
        var consumerAuthInfo = { challengeCode: '04' };
        logger.info('buildConsumerAuthenticationInformation: SCA required flag detected, setting challengeCode=04');
        // Clear the flag after using it (one-time use per retry)
        session.privacy.scaRequired = false;
        return consumerAuthInfo;
    }
    // Otherwise, omit the field entirely
    return null;
}

/**
 * Set SCA required flag in session
 * Call this when a 478/SCA-required response is received to trigger
 * challengeCode=04 on the next capture context generation
 */
function setSCARequiredFlag() {
    session.privacy.scaRequired = true;
    logger.info('setSCARequiredFlag: SCA required flag set for next capture context');
}

/**
 * Check if SCA was required (without clearing the flag)
 * @returns {boolean} - True if SCA was required on previous attempt
 */
function isSCARequired() {
    return !!session.privacy.scaRequired;
}

/**
 * Get SCA error message for cardholder display
 * @returns {string} - Localized error message for SCA requirement
 */
function getSCAErrorMessage() {
    var Resource = require('dw/web/Resource');
    return Resource.msg('error.sca.required', 'error',
        'Your card issuer requires an extra security check to approve this payment. Please try again and follow the verification steps.');
}

/**
 * Build DDC backup device information for Payer Authentication
 * These fields are collected server-side as backup for 3DS device data collection
 * Required fields per specification:
 * - IP address
 * - Browser navigator.javaEnabled
 * - Accept header
 * - Browser language (IETF BCP47)
 * - Screen colour depth, height, width
 * - Browser time difference
 * - User-Agent header
 * - Transaction channel
 * - Browser ability to execute JavaScript
 * 
 * NOTE: These fields are for payment authorization requests, NOT capture context.
 * For capture context, use buildCaptureContextDeviceInformation() which only includes ipAddress.
 * 
 * @param {Object} configObject - Configuration object from BM
 * @param {Object} browserData - Optional browser data collected from client
 * @returns {Object|null} - deviceInformation object or null if payer auth is disabled
 */
function buildDdcBackupDeviceInformation(configObject, browserData) {
    var secureResponseHelper = require('~/cartridge/scripts/helpers/secureResponseHelper');

    // Check if payer authentication is enabled
    var payerAuthSetting = (configObject.payerAuthenticationEnabled || '').toString().toUpperCase();
    if (payerAuthSetting !== 'YES' && payerAuthSetting !== 'DATA_ONLY_YES' && payerAuthSetting !== 'DATA_ONLY_NO') {
        return null;
    }

    var deviceInformation = {};

    // Server-side collected fields
    deviceInformation.ipAddress = request.httpRemoteAddress;
    deviceInformation.httpAcceptContent = secureResponseHelper.sanitizeHttpHeader(request.httpHeaders.get('accept'));
    deviceInformation.userAgentBrowserValue = secureResponseHelper.sanitizeHttpHeader(request.httpHeaders.get('user-agent'));
    deviceInformation.deviceChannel = 'Browser';

    // Client-side collected fields (if provided)
    if (browserData) {
        if (browserData.httpBrowserJavaEnabled !== undefined) {
            deviceInformation.httpBrowserJavaEnabled = browserData.httpBrowserJavaEnabled;
        }
        if (browserData.httpBrowserLanguage) {
            deviceInformation.httpBrowserLanguage = browserData.httpBrowserLanguage;
        }
        if (browserData.httpBrowserColorDepth) {
            deviceInformation.httpBrowserColorDepth = String(browserData.httpBrowserColorDepth);
        }
        if (browserData.httpBrowserScreenHeight) {
            deviceInformation.httpBrowserScreenHeight = String(browserData.httpBrowserScreenHeight);
        }
        if (browserData.httpBrowserScreenWidth) {
            deviceInformation.httpBrowserScreenWidth = String(browserData.httpBrowserScreenWidth);
        }
        if (browserData.httpBrowserTimeDifference !== undefined) {
            deviceInformation.httpBrowserTimeDifference = String(browserData.httpBrowserTimeDifference);
        }
        if (browserData.httpBrowserJavaScriptEnabled !== undefined) {
            deviceInformation.httpBrowserJavaScriptEnabled = browserData.httpBrowserJavaScriptEnabled;
        }
    }

    return deviceInformation;
}

// ============================================================================
// Module Exports
// ============================================================================

module.exports = {
    // Token processing
    processUCToken: processUCToken,
    populateBasketAddresses: populateBasketAddresses,
    updateViewDataFromForm: updateViewDataFromForm,
    populateBasketAddressesFromPaymentDetails: populateBasketAddressesFromPaymentDetails,
    applyAmountDetailsFromPaymentDetails: applyAmountDetailsFromPaymentDetails,

    // Card type mapping
    mapCardType: mapCardType,

    // JWT decoding
    decodeJwtPayload: decodeJwtPayload,

    // Payment method detection
    detectPaymentMethod: detectPaymentMethod,

    getApmDescriptor: getApmDescriptor,
    getApmDisplayName: getApmDisplayName,

    getProcessorIdForMethod: getProcessorIdForMethod,
    extractBankDetails: extractBankDetails,

    // Card details extraction
    extractCardDetails: extractCardDetails,
    buildPaymentDetailsString: buildPaymentDetailsString,
    updatePaymentInstrumentCardDetails: updatePaymentInstrumentCardDetails,

    // Transaction custom attributes
    setTransactionCustomAttribute: setTransactionCustomAttribute,

    setInstrumentCustomAttribute: setInstrumentCustomAttribute,


    // Authorization status
    isValidAuthorizationStatus: isValidAuthorizationStatus,
    getAuthorizationErrorMessage: getAuthorizationErrorMessage,

    // Capture context builders
    buildBillToAddress: buildBillToAddress,
    buildShipToAddress: buildShipToAddress,
    buildLineItems: buildLineItems,
    buildCompleteMandate: buildCompleteMandate,
    buildTransientTokenResponseOptions: buildTransientTokenResponseOptions,
    buildOrderInformation: buildOrderInformation,
    buildBillToFromCustomerAddress: buildBillToFromCustomerAddress,
    buildCardHolderName: buildCardHolderName,
    buildCaptureContextDeviceInformation: buildCaptureContextDeviceInformation,
    buildConsumerAuthenticationInformation: buildConsumerAuthenticationInformation,
    buildDdcBackupDeviceInformation: buildDdcBackupDeviceInformation,

    // SCA (Strong Customer Authentication) handling
    setSCARequiredFlag: setSCARequiredFlag,
    isSCARequired: isSCARequired,
    getSCAErrorMessage: getSCAErrorMessage,

    // Currency formatting
    getCurrencyDecimalPlaces: getCurrencyDecimalPlaces,
    formatAmount: formatAmount,

    // TMS token saving
    getExistingTmsCustomerId: getExistingTmsCustomerId,
    buildTmsTokenTypes: buildTmsTokenTypes,
    buildSerializedToken: buildSerializedToken,
    didUserRequestSaveCard: didUserRequestSaveCard,
    extractTokenInformation: extractTokenInformation,
    findCreditCardByInstrumentIdentifier: findCreditCardByInstrumentIdentifier,
    upsertCreditCard: upsertCreditCard,
    saveTokenToWallet: saveTokenToWallet,

    // Shipping method
    setDefaultShippingMethod: setDefaultShippingMethod
};
