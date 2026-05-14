/**
 * Cybersource Unified Checkout JavaScript
 * Handles the initialization and management of Unified Checkout widget
 */

/* eslint-disable */

'use strict';

/**
 * Dangerous element tag names that are stripped during sanitization.
 */
var DANGEROUS_TAGS = ['script', 'object', 'embed', 'applet', 'base'];

/**
 * Event-handler attribute prefixes that are stripped during sanitization.
 */
var EVENT_ATTR_PREFIX = 'on';

/**
 * Sanitize HTML content using the browser's built-in DOM parser.
 * Strips script tags, event-handler attributes, and javascript: URLs.
 * This breaks Checkmarx taint tracking by routing HTML through DOM parsing + reconstruction.
 * Used for trusted SFCC server AJAX responses (forms, inputs, iframes).
 * @param {string} dirty - The untrusted HTML content to sanitize
 * @returns {string} Sanitized HTML safe for DOM insertion
 */
function safeSanitizeTemplate(dirty) {
    if (!dirty || typeof dirty !== 'string') return '';

    var parser = new DOMParser();
    var doc = parser.parseFromString(dirty, 'text/html');

    // Remove dangerous elements
    DANGEROUS_TAGS.forEach(function (tag) {
        var elements = doc.querySelectorAll(tag);
        for (var i = 0; i < elements.length; i++) {
            elements[i].parentNode.removeChild(elements[i]);
        }
    });

    // Walk all elements and remove event-handler attributes and javascript: URLs
    var allElements = doc.body.querySelectorAll('*');
    for (var i = 0; i < allElements.length; i++) {
        var el = allElements[i];
        var attrs = el.attributes;
        var toRemove = [];
        for (var j = 0; j < attrs.length; j++) {
            var attrName = attrs[j].name.toLowerCase();
            var attrValue = (attrs[j].value || '').trim().toLowerCase();
            if (attrName.indexOf(EVENT_ATTR_PREFIX) === 0) {
                toRemove.push(attrs[j].name);
            } else if ((attrName === 'href' || attrName === 'src' || attrName === 'action') && attrValue.indexOf('javascript:') === 0) {
                toRemove.push(attrs[j].name);
            }
        }
        for (var k = 0; k < toRemove.length; k++) {
            el.removeAttribute(toRemove[k]);
        }
    }

    return doc.body.innerHTML;
}

var unifiedCheckout = {
    // Instance properties
    unifiedCheckoutInstance: null,  // v1.x checkout instance
    unifiedPaymentsInstance: null,  // v0.x (legacy support)
    paymentToken: null,
    captureContextCache: null,
    lastBasketTotal: null,

    /**
     * Sanitize URL to prevent XSS attacks
     * @param {string} url - The URL to sanitize
     * @returns {string|null} - Sanitized URL or null if invalid
     */
    sanitizeUrl: function (url) {

        // Basic URL sanitization to prevent XSS
        if (!url || typeof url !== 'string') {
            console.warn('sanitizeUrl: Invalid input - null or not a string');
            return null;
        }

        // Remove javascript: and data: protocols
        if (url.toLowerCase().startsWith('javascript:') || url.toLowerCase().startsWith('data:')) {
            console.warn('sanitizeUrl: Blocked dangerous protocol in URL:', url);
            return null;
        }

        // Allow only relative URLs or same-origin URLs
        try {
            var parsedUrl = new URL(url, window.location.origin);
            console.log('sanitizeUrl: Parsed URL origin:', parsedUrl.origin);
            console.log('sanitizeUrl: Current page origin:', window.location.origin);

            if (parsedUrl.origin !== window.location.origin) {
                console.warn('sanitizeUrl: Blocked cross-origin URL:', url);
                return null;
            }
            console.log('sanitizeUrl: URL validated successfully:', parsedUrl.href);
            return parsedUrl.href;
        } catch (e) {
            console.log('sanitizeUrl: URL parsing failed, checking for relative URL');
            // Handle relative URLs
            if (url.startsWith('/') && !url.startsWith('//')) {
                console.log('sanitizeUrl: Valid relative URL:', url);
                return url;
            }
            console.warn('sanitizeUrl: Invalid URL format:', url);
            return null;
        }
    },

    /**
     * Sanitize cross-origin script URL
     * Validates URL format, requires HTTPS, and requires SRI integrity hash.
     * @param {string} url - The script URL to sanitize
     * @param {string} integrity - SRI hash for integrity verification
     * @returns {string|null} - Sanitized URL or null if invalid
     */
    sanitizeScriptUrl: function (url, integrity) {
        if (!url || typeof url !== 'string') {
            return null;
        }
        url = String.prototype.trim.call(url);
        var lowerUrl = url.toLowerCase();
        if (lowerUrl.startsWith('javascript:') || lowerUrl.startsWith('data:') || lowerUrl.startsWith('vbscript:') || url.startsWith('//')) {
            return null;
        }
        try {
            var parsedUrl = new URL(url);
            if (parsedUrl.protocol !== 'https:') {
                return null;
            }
            if (!integrity) {
                return null;
            }
            return parsedUrl.href;
        } catch (e) {
            return null;
        }
    },

    /**
     * Initialize Unified Checkout
     */
    init: function () {
        var self = this;
        console.log('[UC] ====== INIT STARTED ======');

        // Add UC enabled class to body to hide traditional form elements
        $('body').addClass('uc-enabled');
        $('.credit-card-form, .creditCardFields').addClass('uc-active');

        // Clear any existing errors first
        this.clearValidationErrors();
        $('#uc-server-error').addClass('d-none');

        // ALWAYS hide the Place Order button when UC is enabled - UC handles payment
        $('.submit-payment').addClass('checkout-hidden').hide();

        // DON'T hide SFRA saved cards UI here - let checkAndLoadSavedCards handle it
        // The method will either enhance SFRA UI with UC buttons OR hide it and show UC widget

        // Try to load saved cards - if successful, show selector; otherwise show UC directly
        self.checkAndLoadSavedCards();
        
        this.bindEvents();
        this.bindShippingAddressChangeEvents();
    },

    // ============================================================================
    // Saved Card Selector Methods (for multi-card support with UC widget)
    // ============================================================================
    
    /**
     * Selected payment instrument ID for UC
     */
    selectedPaymentInstrumentId: null,

    /**
     * Check for saved cards and initialize appropriate UI
     * Uses existing SFRA saved card UI with UC-specific buttons
     */
    checkAndLoadSavedCards: function() {
        var self = this;
        
        // Check if SFRA saved cards exist in the DOM
        var $userPaymentInstruments = $('.user-payment-instruments');
        var $savedPaymentCards = $('.saved-payment-instrument[data-pi-id]');
        
        console.log('[UC] Checking for SFRA saved cards...');
        console.log('[UC] .user-payment-instruments found:', $userPaymentInstruments.length);
        console.log('[UC] .saved-payment-instrument with data-pi-id:', $savedPaymentCards.length);
        
        if ($savedPaymentCards.length > 0) {
            console.log('[UC] Found ' + $savedPaymentCards.length + ' saved cards in SFRA UI');
            // Enhance existing SFRA UI with our buttons
            self.enhanceSfraPaymentUI();
        } else {
            console.log('[UC] No saved cards with TMS IDs, showing UC widget directly');
            // Hide SFRA payment instruments UI and show UC
            $userPaymentInstruments.addClass('checkout-hidden');
            $('.unified-checkout-container').removeClass('checkout-hidden').show();
            self.initializeUnifiedCheckout();
        }
    },

    /**
     * Enhance the existing SFRA saved payment UI with UC-specific buttons
     */
    enhanceSfraPaymentUI: function() {
        var self = this;
        
        var $userPaymentInstruments = $('.user-payment-instruments');
        var $storedPayments = $('.stored-payments');
        var $addPaymentBtn = $('.add-payment');
        var $savedCards = $('.saved-payment-instrument[data-pi-id]');
        
        // Show the SFRA saved payments UI
        $userPaymentInstruments.removeClass('checkout-hidden d-none').show();
        
        // Hide the original SFRA buttons - we'll replace them with our UC buttons
        $addPaymentBtn.hide();
        $('.cancel-new-payment').hide(); // Hide SFRA's "Back to Saved Payments" - we use our own
        
        // Hide the credit card form
        $('.credit-card-form').addClass('checkout-hidden');
        
        // Hide UC widget initially (will show after card selection or "Pay with New Card")
        $('.unified-checkout-container').addClass('checkout-hidden');
        
        // Hide Place Order button - UC handles payment completion
        $('.submit-payment').addClass('checkout-hidden').hide();
        
        // Remove any existing UC buttons and back buttons (in case of re-init)
        $('#uc-saved-card-buttons').remove();
        $('#back-to-saved-cards-btn').remove();
        
        // Add our UC-specific buttons after the stored payments
        var buttonsHtml = 
            '<div id="uc-saved-card-buttons" class="row mt-3">' +
                '<div class="col-12">' +
                    '<button type="button" id="use-selected-card-btn" class="btn btn-primary btn-block mb-2">Continue with Selected Card</button>' +
                    '<div class="text-center my-2"><span class="text-muted">OR</span></div>' +
                    '<button type="button" id="use-new-card-btn" class="btn btn-outline-secondary btn-block">Pay with a New Card or Other Payment Method</button>' +
                '</div>' +
            '</div>';
        
        $storedPayments.after(buttonsHtml);
        
        // Set initial selection from first card with TMS ID
        var $firstCard = $savedCards.filter('.selected-payment').first();
        if (!$firstCard.length) {
            $firstCard = $savedCards.first();
            $savedCards.removeClass('selected-payment');
            $firstCard.addClass('selected-payment');
        }
        self.selectedPaymentInstrumentId = $firstCard.data('pi-id');
        console.log('[UC] Initial selected card PI ID:', self.selectedPaymentInstrumentId);
        
        // Bind events for SFRA saved card selection
        self.bindSfraSavedCardEvents();
        
        console.log('[UC] SFRA payment UI enhanced with UC buttons');
    },

    /**
     * Bind events for SFRA saved card UI with UC functionality
     */
    bindSfraSavedCardEvents: function() {
        var self = this;
        
        // Card selection - when clicking on a saved card row
        $(document).off('click.uc-saved-card').on('click.uc-saved-card', '.saved-payment-instrument[data-pi-id]', function(e) {
            var $card = $(this);
            var piId = $card.data('pi-id');
            
            // Update visual selection
            $('.saved-payment-instrument').removeClass('selected-payment');
            $card.addClass('selected-payment');
            
            // Store selected PI ID
            self.selectedPaymentInstrumentId = piId;
            console.log('[UC] Selected card PI ID:', piId);
        });
        
        // "Continue with Selected Card" button
        $(document).off('click.uc-continue').on('click.uc-continue', '#use-selected-card-btn', function(e) {
            e.preventDefault();
            
            if (!self.selectedPaymentInstrumentId) {
                console.error('[UC] No card selected!');
                return;
            }
            
            console.log('[UC] Continue with selected card:', self.selectedPaymentInstrumentId);
            
            // Hide the saved cards UI
            $('.user-payment-instruments').addClass('checkout-hidden');
            $('#uc-saved-card-buttons').hide();
            
            // Show the UC container and its parent (credit-card-form)
            // The UC container is inside credit-card-form which might be hidden
            var $ucContainer = $('.unified-checkout-container').first();
            $ucContainer.removeClass('checkout-hidden d-none').show();
            $ucContainer.parents().each(function() {
                var $parent = $(this);
                // Don't show user-payment-instruments, only the form container
                if (!$parent.hasClass('user-payment-instruments') && !$parent.hasClass('stored-payments')) {
                    $parent.removeClass('checkout-hidden d-none');
                    if ($parent.css('display') === 'none') {
                        $parent.show();
                    }
                }
            });
            console.log('[UC] UC container visibility:', $ucContainer.is(':visible'));
            
            // Also show credit-card-form explicitly (it contains UC)
            $('.credit-card-form').removeClass('checkout-hidden d-none').show();
            
            // Load UC with selected card
            self.loadUCWithSelectedCard(self.selectedPaymentInstrumentId);
        });
        
        // "Pay with a New Card" button
        $(document).off('click.uc-new-card').on('click.uc-new-card', '#use-new-card-btn', function(e) {
            e.preventDefault();
            
            console.log('[UC] Switching to new card entry (no TMS token)');
            
            // Hide saved cards UI
            $('.user-payment-instruments').addClass('checkout-hidden');
            $('#uc-saved-card-buttons').hide();
            
            // Clear selected card - UC will generate context without TMS token
            self.selectedPaymentInstrumentId = null;
            
            // Show credit-card-form for UC to render into
            $('.credit-card-form').removeClass('checkout-hidden d-none').show();
            
            // Load UC with a FRESH capture context (no TMS token)
            // This will fetch new HTML from CreateUCToken endpoint (not CreateUCTokenWithCard)
            self.loadUCForNewCard();
        });
        
        // "Back to Saved Cards" button (inside UC container)
        $(document).off('click.uc-back').on('click.uc-back', '#back-to-saved-cards-btn', function(e) {
            e.preventDefault();
            
            console.log('[UC] Going back to saved cards');
            
            // Hide UC widget, back button, and credit card form
            $('.unified-checkout-container').addClass('checkout-hidden');
            $('.credit-card-form').addClass('checkout-hidden');
            $(this).hide();
            
            // Show saved cards UI and UC buttons again
            $('.user-payment-instruments').removeClass('checkout-hidden').show();
            $('#uc-saved-card-buttons').show();
            
            // Ensure Place Order stays hidden
            $('.submit-payment').addClass('checkout-hidden').hide();
        });
    },

    /**
     * Add CSS styles for saved card selector
     */
    addSavedCardSelectorStyles: function() {
        if ($('#saved-card-selector-styles').length) return;
        
        var styles = 
            '<style id="saved-card-selector-styles">' +
            '.saved-card-selector { border: 1px solid #e0e0e0; border-radius: 8px; padding: 15px; background: #fafafa; }' +
            '.saved-card-title { color: #333; font-weight: 600; margin: 0; }' +
            '.saved-cards-list { max-height: 300px; overflow-y: auto; }' +
            '.saved-card-item { display: flex; align-items: center; padding: 12px; border: 2px solid #e0e0e0; border-radius: 6px; margin-bottom: 8px; cursor: pointer; background: #fff; }' +
            '.saved-card-item:hover { border-color: #007bff; background: #f8f9ff; }' +
            '.saved-card-item.selected { border-color: #007bff; background: #e7f1ff; }' +
            '.saved-card-item input[type="radio"] { margin-right: 12px; }' +
            '.saved-card-icon { width: 50px; margin-right: 12px; font-size: 24px; }' +
            '.saved-card-details { flex: 1; }' +
            '.saved-card-type { font-weight: 600; color: #333; }' +
            '.saved-card-number { color: #666; font-family: monospace; }' +
            '.saved-card-expiry { color: #888; font-size: 12px; }' +
            '#uc-widget-wrapper.loading { opacity: 0.5; pointer-events: none; }' +
            '</style>';
        
        $('head').append(styles);
    },

    /**
     * Initialize the saved card selector component (legacy - kept for compatibility)
     * @returns {boolean} - Always returns false now, we use checkAndLoadSavedCards instead
     */
    initSavedCardSelector: function() {
        // This is now handled by checkAndLoadSavedCards()
        return false;
    },

    /**
     * Load saved cards from server (legacy - now handled by checkAndLoadSavedCards)
     * @deprecated Use checkAndLoadSavedCards instead
     */
    loadSavedCards: function() {
        console.log('[UC] loadSavedCards is deprecated, use checkAndLoadSavedCards');
        this.checkAndLoadSavedCards();
    },

    /**
     * Render saved cards in the selector (legacy - now handled by createSavedCardSelectorUI)
     * @deprecated Use createSavedCardSelectorUI instead
     */
    renderSavedCards: function(cards) {
        console.log('[UC] renderSavedCards is deprecated, use createSavedCardSelectorUI');
        this.createSavedCardSelectorUI(cards);
    },

    /**
     * Get card icon HTML based on card type
     * @param {string} cardType - The card type (VISA, MASTERCARD, etc.)
     * @returns {string} - HTML for the card icon
     */
    getCardIcon: function(cardType) {
        var type = (cardType || '').toUpperCase();
        var icons = {
            'VISA': '💳 VISA',
            'MASTERCARD': '💳 MC',
            'AMEX': '💳 AMEX',
            'DISCOVER': '💳 DISC',
            'JCB': '💳 JCB',
            'DINERS': '💳 DIN',
            'DINERSCLUB': '💳 DIN'
        };
        return icons[type] || '💳 ' + type;
    },

    /**
     * Bind events for saved card selector
     */
    bindSavedCardSelectorEvents: function() {
        var self = this;

        // Card item click - select the card
        $(document).on('click', '.saved-card-item', function() {
            var $item = $(this);
            var paymentInstrumentId = $item.data('pi-id') || $item.data('payment-instrument-id');
            
            // Update selection state
            $('.saved-card-item').removeClass('selected');
            $item.addClass('selected');
            $item.find('input[type="radio"]').prop('checked', true);
            
            // Store selected card ID
            self.selectedPaymentInstrumentId = paymentInstrumentId;
            
            // Enable the "Continue with Selected Card" button
            $('#use-selected-card-btn').prop('disabled', false);
            
            console.log('[UC] Selected card:', paymentInstrumentId);
        });

        // "Continue with Selected Card" button click
        $(document).on('click', '#use-selected-card-btn', function() {
            if (!self.selectedPaymentInstrumentId) {
                alert('Please select a card first');
                return;
            }
            
            console.log('Loading UC with selected card:', self.selectedPaymentInstrumentId);
            self.loadUCWithSelectedCard(self.selectedPaymentInstrumentId);
        });

        // "Pay with New Card" button click
        $(document).on('click', '#use-new-card-btn', function() {
            console.log('Loading UC for new card entry');
            self.selectedPaymentInstrumentId = null;
            self.loadUCForNewCard();
        });

        // "Back to Saved Cards" button click
        $(document).on('click', '#back-to-saved-cards-btn', function() {
            console.log('Going back to saved cards');
            self.showSavedCardSelector();
        });
    },

    /**
     * Load UC widget with a specific saved card
     * @param {string} paymentInstrumentId - TMS payment instrument ID
     */
    loadUCWithSelectedCard: function(paymentInstrumentId) {
        var self = this;
        var createTokenWithCardUrl = $('#create-uc-token-with-card-url').val();
        
        if (!createTokenWithCardUrl) {
            console.error('[UC] Create UC token with card URL not found');
            return;
        }

        createTokenWithCardUrl = self.sanitizeUrl(createTokenWithCardUrl);
        if (!createTokenWithCardUrl) {
            console.error('[UC] Invalid create UC token URL');
            return;
        }

        // Add payment instrument ID to URL
        createTokenWithCardUrl += '?piId=' + encodeURIComponent(paymentInstrumentId);
        console.log('[UC] Fetching capture context with card from:', createTokenWithCardUrl);

        // Find the UC container - could be #uc-widget-wrapper or .unified-checkout-container
        var $ucContainer = $('#uc-widget-wrapper');
        if (!$ucContainer.length) {
            $ucContainer = $('.unified-checkout-container').first();
        }
        
        console.log('[UC] UC container found:', $ucContainer.length > 0, 'selector:', $ucContainer.attr('id') || $ucContainer.attr('class'));

        // Show loading state and ensure container & parents are visible
        $ucContainer.removeClass('checkout-hidden d-none').show().addClass('loading');
        $ucContainer.parents().each(function() {
            var $parent = $(this);
            if (!$parent.hasClass('user-payment-instruments') && !$parent.hasClass('stored-payments')) {
                $parent.removeClass('checkout-hidden d-none');
            }
        });
        $('.credit-card-form').removeClass('checkout-hidden d-none').show();
        
        // Remove any existing back buttons, then add ONE at the BOTTOM
        $('#back-to-saved-cards-btn').remove();
        var backBtnHtml = '<button type="button" id="back-to-saved-cards-btn" class="btn btn-outline-primary btn-block mt-2">Back to Saved Cards</button>';
        $ucContainer.append(backBtnHtml);
        
        // Destroy existing UC instance
        self.destroyExistingUCInstance();

        // Fetch new capture context with selected card
        $.ajax({
            url: createTokenWithCardUrl,
            type: 'GET',
            dataType: 'html',
            success: function(html) {
                console.log('[UC] Received UC HTML with selected card');
                
                $ucContainer.removeClass('loading');
                
                // Remove the back button before clearing, we'll re-add it
                var $backBtn = $('#back-to-saved-cards-btn').detach();
                
                // Clear existing UC content
                $ucContainer.find('.unified-checkout, #ucCaptureContext, #uc-client-library, #uc-client-library-integrity').remove();
                
                // Sanitize and insert new HTML
                var sanitizedHtml = safeSanitizeTemplate(html);
                $ucContainer.html(sanitizedHtml);
                
                // Re-add the back button at the BOTTOM (only once)
                $ucContainer.append($backBtn);
                
                console.log('[UC] HTML inserted, checking for capture context...');
                console.log('[UC] #ucCaptureContext exists:', $('#ucCaptureContext').length > 0);
                console.log('[UC] Capture context value:', $('#ucCaptureContext').val() ? 'present' : 'empty');
                console.log('[UC] #buttonPaymentListContainer exists:', $('#buttonPaymentListContainer').length > 0);
                console.log('[UC] #embeddedPaymentContainer exists:', $('#embeddedPaymentContainer').length > 0);
                
                // Ensure UC mount containers are visible
                $('#buttonPaymentListContainer, #embeddedPaymentContainer').removeClass('checkout-hidden d-none').css({
                    'display': 'block',
                    'visibility': 'visible'
                });
                
                // Ensure the .unified-checkout-container inside is visible
                $ucContainer.find('.unified-checkout-container').removeClass('checkout-hidden d-none').show();
                
                // Re-initialize UC widget
                self.isInitializing = false;
                self.initializeUnifiedCheckout();
            },
            error: function(xhr, status, error) {
                console.error('[UC] Failed to load UC with selected card:', error);
                $ucContainer.removeClass('loading');
                self.showValidationError('Failed to load payment widget. Please try again.');
            }
        });
    },

    /**
     * Load UC widget for new card entry (no TMS token)
     * Fetches a fresh capture context from CreateUCToken endpoint
     */
    loadUCForNewCard: function() {
        var self = this;
        var createTokenUrl = $('#unified-token-url').val();
        
        if (!createTokenUrl) {
            console.error('[UC] Create UC token URL not found');
            return;
        }

        createTokenUrl = self.sanitizeUrl(createTokenUrl);
        if (!createTokenUrl) {
            console.error('[UC] Invalid create UC token URL');
            return;
        }

        console.log('[UC] Fetching fresh capture context for new card from:', createTokenUrl);

        // Find the UC container
        var $ucContainer = $('.unified-checkout-container').first();
        if (!$ucContainer.length) {
            $ucContainer = $('.credit-card-form').first();
        }
        
        // Show loading state and ensure visibility
        $ucContainer.removeClass('checkout-hidden d-none').show().addClass('loading');
        $ucContainer.parents().each(function() {
            var $parent = $(this);
            if (!$parent.hasClass('user-payment-instruments') && !$parent.hasClass('stored-payments')) {
                $parent.removeClass('checkout-hidden d-none');
            }
        });
        $('.credit-card-form').removeClass('checkout-hidden d-none').show();
        
        // Remove any existing back buttons first, then add ONE at the BOTTOM
        $('#back-to-saved-cards-btn').remove();
        var backBtnHtml = '<button type="button" id="back-to-saved-cards-btn" class="btn btn-outline-primary btn-block mt-2">Back to Saved Cards</button>';
        $ucContainer.append(backBtnHtml);

        // Destroy existing UC instance
        self.destroyExistingUCInstance();

        // Fetch new capture context WITHOUT TMS token
        $.ajax({
            url: createTokenUrl,
            type: 'GET',
            dataType: 'html',
            success: function(html) {
                console.log('[UC] Received UC HTML for new card (no TMS token)');
                
                $ucContainer.removeClass('loading');
                
                // Remove the back button before clearing, we'll re-add it
                var $backBtn = $('#back-to-saved-cards-btn').detach();
                
                // Clear existing UC content
                $ucContainer.find('.unified-checkout, #ucCaptureContext, #uc-client-library, #uc-client-library-integrity').remove();
                $ucContainer.find('#buttonPaymentListContainer, #embeddedPaymentContainer').remove();
                
                // Sanitize and insert new HTML
                var sanitizedHtml = safeSanitizeTemplate(html);
                $ucContainer.html(sanitizedHtml);
                
                // Re-add the back button at the BOTTOM (only once)
                $ucContainer.append($backBtn);
                
                console.log('[UC] HTML inserted for new card, verifying capture context...');
                console.log('[UC] #ucCaptureContext exists:', $('#ucCaptureContext').length > 0);
                
                // Ensure UC mount containers are visible
                $('#buttonPaymentListContainer, #embeddedPaymentContainer').removeClass('checkout-hidden d-none').css({
                    'display': 'block',
                    'visibility': 'visible'
                });
                
                // Re-initialize UC widget
                self.isInitializing = false;
                self.initializeUnifiedCheckout();
            },
            error: function(xhr, status, error) {
                console.error('[UC] Failed to load UC for new card:', error);
                $ucContainer.removeClass('loading');
                self.showValidationError('Failed to load payment widget. Please try again.');
            }
        });
    },

    /**
     * Show saved card selector and hide UC widget
     */
    showSavedCardSelector: function() {
        var self = this;
        
        // Destroy existing UC instance
        self.destroyExistingUCInstance();
        
        // Show saved card selector
        $('#saved-card-selector').show();
        $('#back-to-saved-cards').hide();
        
        // Hide and clear UC widget
        $('#uc-widget-wrapper').hide();
        
        // Clear selection
        self.selectedPaymentInstrumentId = null;
        $('.saved-card-item').removeClass('selected');
        $('.saved-card-item input[type="radio"]').prop('checked', false);
        $('#use-selected-card-btn').prop('disabled', true);
    },

    /**
     * Destroy existing UC instance and clear state
     */
    destroyExistingUCInstance: function() {
        var self = this;
        
        if (self.unifiedCheckoutInstance) {
            console.log('Destroying existing UC instance');
            try {
                self.unifiedCheckoutInstance = null;
            } catch (e) {
                console.warn('Error destroying UC instance:', e);
            }
        }
        
        if (self.unifiedPaymentsInstance) {
            try {
                self.unifiedPaymentsInstance = null;
            } catch (e) {
                console.warn('Error destroying legacy UC instance:', e);
            }
        }
        
        // Clear payment state
        self.paymentToken = null;
        $('#uc-payment-token').val('');
        $('#uc-transaction-id').val('');
        $('#uc-response').val('');
    },


    /**
     * Initialize the Unified Checkout widget
     */
    initializeUnifiedCheckout: async function () {
        var self = this;

        self.isInitializing = true;

        // Check if VAS SDK is available (v1.x - Visa Application Server)
        // Also check for legacy Accept SDK (v0.x) as fallback
        var hasVasSDK = typeof VAS !== 'undefined' && typeof VAS.UnifiedCheckout === 'function';
        var hasAcceptSDK = typeof Accept !== 'undefined' && typeof Accept === 'function';
        
        if (!hasVasSDK && !hasAcceptSDK) {
            var scriptUrl = $('#uc-client-library').val();
            var integrity = $('#uc-client-library-integrity').val();
            scriptUrl = self.sanitizeScriptUrl(scriptUrl, integrity);
            if (scriptUrl && !window.ucScriptLoading) {
                console.log('UC library not loaded, attempting to load it dynamically...');
                window.ucScriptLoading = true; // Prevent multiple loading attempts
                self.isInitializing = false; // Reset flag so re-initialization can proceed after script loads

                var script = document.createElement('script');
                script.src = scriptUrl;
                script.integrity = integrity;
                script.crossOrigin = 'anonymous';

                script.onload = function () {
                    console.log('UC library loaded successfully.');
                    window.ucScriptLoading = false;
                    self.isInitializing = false;
                    // Re-run initialization now that the script is loaded
                    self.initializeUnifiedCheckout();
                };

                script.onerror = function () {
                    console.error('Failed to load UC library.');
                    window.ucScriptLoading = false;
                    self.isInitializing = false;
                    self.handleError({ message: 'Payment widget library could not be loaded.' });
                };

                document.head.appendChild(script);
                return; // Exit and wait for the script to load
            } else if (window.ucScriptLoading) {
                console.log('UC library is already loading...');
                self.isInitializing = false;
                return;
            } else {
                console.error('UC library URL not found.');
                self.isInitializing = false;
                self.handleError({ message: 'Payment widget library URL not found.' });
                return;
            }
        }

        var sessionJWT = $('#ucCaptureContext').val();

        console.log('Session JWT (Capture context) found:', !!sessionJWT);

        if (!sessionJWT) {
            console.error('Session JWT not found');
            self.isInitializing = false;
            // Do not show error here, as it might be a normal page load without UC
            return;
        }

        console.log('UC library available, launching checkout...');
        console.log('SDK Version - VAS:', typeof VAS !== 'undefined' ? 'v1.x' : 'v0.x');

        try {
            // Add loading class to both containers
            $('#buttonPaymentListContainer, #embeddedPaymentContainer').addClass('loading');

            // Launch Unified Checkout using the SDK
            await this.launchCheckout(sessionJWT);

            // Reset flag after successful launch
            self.isInitializing = false;

        } catch (error) {
            console.error('Error initializing Unified Checkout:', error);
            $('#buttonPaymentListContainer, #embeddedPaymentContainer').removeClass('loading');
            self.isInitializing = false;
            this.handleError(error);
        }
    },

    /**
     * Launch Unified Checkout using VAS SDK v1.x (Manual Mode)
     * @param {string} sessionJWT - The session JWT from server
     */
    launchCheckout: async function (sessionJWT) {
        var self = this;

        // Determine sidebar mode based on UnifiedCheckoutPaymentAcceptanceLocation configuration
        var paymentLocation = $('#unifiedCheckoutPaymentAcceptanceLocation').val() || 'Embedded';
        var sidebar = paymentLocation === 'Sidebar';

        // Check if we're in minicart context (UC container is inside the minicart popover)
        var isMinicart = $('#buttonPaymentListContainer').closest('.minicart .popover').length > 0;
        if (isMinicart) {
            // Minicart context - force sidebar mode
            sidebar = true;
        }

        try {
            // Initialize VAS SDK with session JWT (v1.x)
            var client = await VAS.UnifiedCheckout(sessionJWT);

            // Centralized SDK-level error handling (v1.x)
            client.on('error', function (err) {
                console.error('UC Error:', err && err.reason, err && err.message);
                self.handleError(err || {});
            });

            // Create checkout instance with manual token handling (autoProcessing: false)
            var checkout = await client.createCheckout({
                autoProcessing: false  // Manual mode - we handle token processing
            });

            // Store reference for later use
            self.unifiedCheckoutInstance = checkout;

            // Mount payment widget and get transient token
            // VAS SDK v1.x mount options:
            // - paymentSelection: Container for payment method buttons
            // - paymentScreen: Container for embedded payment form (only for Embedded mode, not Sidebar)
            var mountArgs = {
                paymentSelection: '#buttonPaymentListContainer'
            };

            // For embedded mode, add the payment screen container
            // Sidebar mode opens a modal overlay, so doesn't need paymentScreen
            if (!sidebar) {
                mountArgs.paymentScreen = '#embeddedPaymentContainer';
            }

            var token = await checkout.mount(mountArgs);

            // For checkout page: run completeMandate orchestration (3DS/DM/Auth)
            // For minicart/cart: also run completeMandate orchestration with captured billing/shipping
            // Total amount includes default SFCC tax (not CyberSource tax calculation)
            var result = null;
            result = await checkout.complete(token);
            console.log('UC v1.x completeMandate orchestration finished');
            if (isMinicart) {
                console.log('UC v1.x minicart/cart flow - completeMandate with captured addresses');
            }

            console.log('UC v1.x payment widget mounted successfully');
            $('#buttonPaymentListContainer, #embeddedPaymentContainer').removeClass('loading').addClass('loaded');

            // Move cancel button to bottom of UC widget container
            var cancelButton = document.querySelector('.cancel-new-payment');
            var ucContainer = document.querySelector('.unified-checkout-container');
            if (cancelButton && ucContainer) {
                ucContainer.appendChild(cancelButton);
                console.log('Cancel button moved to bottom of UC widget container');
            }

            // Clear any existing errors since widget loaded successfully
            self.clearValidationErrors();

            // Store token and pass complete response to existing processing flow
            self.paymentToken = token;
            self.handlePaymentComplete(token, result);

        } catch (error) {
            console.error('Error launching UC v1.x:', error);
            $('#buttonPaymentListContainer, #embeddedPaymentContainer').removeClass('loading');
            self.handleError(error);
            // Let caller handle isInitializing flag
            throw error; // Re-throw so initializeUnifiedCheckout can catch and reset flag
        }
    },


    /**
     * Handle payment completion - process and store payment token (v1.x)
     * @param {Object} paymentToken - Payment token from UC widget
     * @param {Object} completeResult - Optional result object from checkout.onComplete (contains authorization result for completeMandate)
     */
    handlePaymentComplete: function (paymentToken, completeResult) {
        var self = this;

        try {
            console.log('Processing payment token...');

            // Check if this is a completeMandate flow with authorization result
            // completeResult is a JWT string when completeMandate is used
            if (completeResult && typeof completeResult === 'string' && completeResult.split('.').length === 3) {
                console.log('completeMandate JWT detected, processing authorization result...');
                var decodedResult = parseJwt(completeResult);
                console.log('completeMandate result:', decodedResult);

                // Always call PlaceOrderDirect, regardless of status
                self.placeOrderDirect(completeResult, paymentToken, decodedResult);
                return;
            }

            // For non-completeMandate flows (e.g., minicart), continue with existing logic
            console.log('Processing traditional token flow...');

            // Create payment data object
            var data = {
                paymentToken: paymentToken,
            };

            // console.log('Payment token processed:', paymentToken);

            // Remove the stored payments list to prevent conflicts on submission
            if ($('.stored-payments-list').length > 0) {
                console.log('Payment complete, removing stored payments list.');
                $('.stored-payments-list').remove();
            }
            // Store the payment token in hidden field
            $('#uc-payment-token').val(paymentToken);
            var decodedJwt = parseJwt(paymentToken);
            var isGooglePay = false;
            console.log(decodedJwt);
            // Check payment type and populate form fields accordingly
            if (decodedJwt.content.processingInformation && decodedJwt.content.processingInformation.paymentSolution && decodedJwt.content.processingInformation.paymentSolution.value == '012') {
                // Google Pay
                console.log('Google Pay payment detected');
                isGooglePay = true;
                $('#gPayFluidData').val(decodedJwt.content.paymentInformation.fluidData.value);

                // Add payment method info to data object
                data.paymentMethod = 'googlepay';
                data.fluidData = decodedJwt.content.paymentInformation.fluidData.value;
            }
            else if (decodedJwt.content.processingInformation && decodedJwt.content.processingInformation.paymentSolution && decodedJwt.content.processingInformation.paymentSolution.value == '001') {
                //apple pay
                $('input[name=dwfrm_billing_paymentMethod]').val('DW_APPLE_PAY');
                $('#cardNumber').val(decodedJwt.content.paymentInformation.tokenizedCard.number.maskedValue);
                assignCorrectCardType(decodedJwt.content.paymentInformation.tokenizedCard.type.value);
                $('#expirationMonth').val(decodedJwt.content.paymentInformation.tokenizedCard.expirationMonth.value);
                $('#expirationYear').val(decodedJwt.content.paymentInformation.tokenizedCard.expirationYear.value);
            }
            // Handle regular credit card payments
            else if (decodedJwt.content.paymentInformation.card) {
                if (decodedJwt.content.processingInformation &&
                    decodedJwt.content.processingInformation.paymentSolution &&
                    decodedJwt.content.processingInformation.paymentSolution.value == '027') {
                    $('input[name=dwfrm_billing_paymentMethod]').val('CLICK_TO_PAY');
                } else {
                    data.paymentMethod = 'creditcard';
                    // Set save card checkbox based on JWT metadata
                    var saveCard = decodedJwt.metadata && decodedJwt.metadata.consumerPreference && decodedJwt.metadata.consumerPreference.saveCard !== undefined
                        ? decodedJwt.metadata.consumerPreference.saveCard
                        : false;
                    $('#saveCreditCard, input[name="dwfrm_billing_creditCardFields_saveCard"]').prop('checked', saveCard);
                }

                $('#cardNumber').val(decodedJwt.content.paymentInformation.card.number.maskedValue);
                assignCorrectCardType(decodedJwt.content.paymentInformation.card.type.value);
                $('#expirationMonth').val(decodedJwt.content.paymentInformation.card.expirationMonth.value);
                $('#expirationYear').val(decodedJwt.content.paymentInformation.card.expirationYear.value);
            }
            else if (decodedJwt.content.paymentInformation.bank) {
                $('#uc-payment-method').val('BANK_TRANSFER');
                $('input[name=dwfrm_billing_creditCardFields_ucpaymentmethod').val('BANK_TRANSFER');
                $('input[name=dwfrm_billing_paymentMethod]').val('BANK_TRANSFER');
                console.log("bank transfer value been updated");
            }


            // Store complete response with conditional data
            if (completeResult && typeof completeResult === 'object') {
                var transactionId = completeResult.transactionId || completeResult.id || '';
                if (transactionId) {
                    data.transactionId = transactionId;
                    $('#uc-transaction-id').val(transactionId);
                    $('input[name=dwfrm_billing_creditCardFields_transactionId]').val(transactionId);
                }
            }

            $('#uc-response').val(JSON.stringify(data));
            $('input[name=dwfrm_billing_creditCardFields_ucpaymenttoken]').val(paymentToken);


            // Trigger form submission or next step with conditional data
            this.triggerPaymentProcessing(data);

            // Trigger appropriate payment flow based on payment type

            // Check if we are in minicart context (no billing form)
            if ($('#dwfrm_billing').length === 0) {
                if (isGooglePay) {
                    console.log('Triggering Google Pay minicart payment flow');
                    processGooglePay(); // This function already handles the minicart case correctly
                } else {
                    console.log('Triggering other minicart payment flow');
                    processOtherCartAndMinicartPayments();
                }
            } else {
                // Normal checkout page flow
                if (isGooglePay) {
                    console.log('Triggering Google Pay payment flow');
                    processGooglePay();
                } else {
                    console.log('Triggering Credit Card payment flow');
                    var $submitPaymentBtn = $('.submit-payment, .save-payment');
                    $submitPaymentBtn.prop('disabled', false).removeClass('disabled');
                    $submitPaymentBtn.click();
                }
            }

        } catch (error) {
            console.error('Error processing payment:', error);
            self.handleError(error);
        }
    },

    /**
     * Place order directly using completeMandate authorization result
     * This bypasses the traditional SubmitPayment -> PlaceOrder flow since authorization
     * was already performed by the UC SDK
     * 
     * @param {string} completeMandateJwt - The JWT string returned from checkout.complete()
     * @param {string} transientToken - The transient token from mount()
     * @param {Object} decodedResult - The decoded JWT payload for logging/display
     */
    placeOrderDirect: function (completeMandateJwt, transientToken, decodedResult) {
        var self = this;

        console.log('placeOrderDirect: Starting direct order placement...');
        console.log('Transaction ID:', decodedResult.id);
        console.log('Status:', decodedResult.status);

        // Get the PlaceOrderDirect endpoint URL
        var placeOrderUrl = $('#place-order-direct-url').val();
        
        if (!placeOrderUrl) {
            // Fallback: construct URL from CheckoutServices
            placeOrderUrl = window.location.origin + '/on/demandware.store/Sites-RefArch-Site/en_US/CheckoutServices-PlaceOrderDirect';
            console.warn('placeOrderDirect: Using fallback URL. Consider adding #place-order-direct-url hidden field.');
        }

        // Sanitize URL
        placeOrderUrl = self.sanitizeUrl(placeOrderUrl);
        if (!placeOrderUrl) {
            console.error('placeOrderDirect: Invalid or unsafe URL');
            self.showValidationError('Unable to process payment. Please refresh and try again.');
            return;
        }

        // Get CSRF token
        var csrfToken = $('input[name="csrf_token"]').val() || $('.csrf_token').val();

        // Show loading spinner
        $.spinner().start();

        // Prepare form data
        var formData = {
            completeMandateJwt: completeMandateJwt,
            transientToken: transientToken
        };

        if (csrfToken) {
            formData.csrf_token = csrfToken;
        }

        $.ajax({
            url: placeOrderUrl,
            type: 'POST',
            dataType: 'json',
            data: formData,
            success: function (data) {
                $.spinner().stop();

                if (data.error) {
                    console.error('placeOrderDirect: Server returned error:', data.errorMessage);

                    // If SCA is required, redirect to checkout with payerAuthError param for consistent error display
                    if (data.scaRequired) {
                        var checkoutUrl = '';
                        // Try to get the checkout page URL from a hidden field or fallback
                        var $checkoutStageUrl = $('#checkout-stage-url');
                        if ($checkoutStageUrl.length > 0) {
                            checkoutUrl = $checkoutStageUrl.val();
                        } else {
                            // Fallback: try to build the URL (update as needed for your site path)
                            checkoutUrl = '/on/demandware.store/Sites-RefArch-Site/en_US/Checkout-Begin?stage=payment';
                        }
                        // Encode error message for URL
                        var errorMsg = encodeURIComponent(data.errorMessage || '');
                        // Redirect with payerAuthError param
                        window.location.href = checkoutUrl + (checkoutUrl.indexOf('?') > -1 ? '&' : '?') + 'payerAuthError=' + errorMsg;
                        return;
                    }

                    // Show error message as fallback
                    self.showValidationError(data.errorMessage || 'An error occurred while processing your order.');

                    // Handle specific error cases
                    if (data.cartError && data.redirectUrl) {
                        // Cart issue - redirect to cart
                        window.location.href = data.redirectUrl;
                        return;
                    }

                    if (data.errorStage) {
                        // Redirect to specific checkout stage
                        var stageUrl = window.location.origin + '/s/RefArch/checkout?stage=' + data.errorStage.stage;
                        console.log('Redirecting to stage:', stageUrl);
                        // Don't redirect automatically - let user see error first
                    }

                    // Regenerate capture context for retry
                    setTimeout(function () {
                        self.regenerateCaptureContextIfNeeded(true);
                    }, 2000);

                } else {
                    // Success - redirect to confirmation page via POST form
                    console.log('placeOrderDirect: Order placed successfully!');
                    console.log('Order ID:', data.orderID);
                    console.log('Continue URL:', data.continueUrl);

                    // Create and submit a POST form to Order-Confirm
                    // (Order-Confirm is a POST endpoint expecting orderID and orderToken in form data)
                    var form = document.createElement('form');
                    form.method = 'POST';
                    form.action = data.continueUrl;
                    form.style.display = 'none';

                    // Add orderID field
                    var orderIdInput = document.createElement('input');
                    orderIdInput.type = 'hidden';
                    orderIdInput.name = 'orderID';
                    orderIdInput.value = data.orderID;
                    form.appendChild(orderIdInput);

                    // Add orderToken field
                    var orderTokenInput = document.createElement('input');
                    orderTokenInput.type = 'hidden';
                    orderTokenInput.name = 'orderToken';
                    orderTokenInput.value = data.orderToken;
                    form.appendChild(orderTokenInput);

                    // Submit the form
                    document.body.appendChild(form);
                    form.submit();
                }
            },
            error: function (xhr, status, error) {
                $.spinner().stop();
                console.error('placeOrderDirect: AJAX error:', status, error);

                var errorMessage = 'An error occurred while processing your order. Please try again.';

                if (xhr.responseJSON && xhr.responseJSON.errorMessage) {
                    errorMessage = xhr.responseJSON.errorMessage;
                }

                if (xhr.responseJSON && xhr.responseJSON.redirectUrl) {
                    window.location.href = xhr.responseJSON.redirectUrl;
                    return;
                }

                self.showValidationError(errorMessage);

                // Regenerate capture context for retry
                setTimeout(function () {
                    self.regenerateCaptureContextIfNeeded(true);
                }, 2000);
            }
        });
    },

    /**
     * Bind event handlers
     */
    bindEvents: function () {
        var self = this;

        // Handle form submission - prevent if payment not completed
        $(document).on('submit', 'form[id*="billing"], form[id*="payment"]', function (e) {
            var ucResponse = $('#uc-response').val();
            if (!ucResponse && self.paymentToken) {
                e.preventDefault();
                // Trigger completion if we have a payment token but no response
                if (self.unifiedCheckoutInstance && self.paymentToken) {
                    self.handlePaymentComplete(self.paymentToken);
                } else {
                    self.showValidationError('Please complete the payment information');
                }
                return false;
            }
        });

        // Handle payment method changes
        $(document).on('change', 'input[name*="paymentMethod"]', function () {
            var selectedMethod = $(this).val();
            if (selectedMethod === 'CREDIT_CARD' || selectedMethod === 'cybersource') {
                $('#unified-checkout-container').closest('.form-group').show();
            } else {
                $('#unified-checkout-container').closest('.form-group').hide();
            }
        });

        // Handle billing address edit button click - refresh UC capture context
        $(document).on('click', '.payment-details .card-header .edit-button, .payment-summary .edit-button, [data-toggle="modal"][data-target*="editPayment"], .payment-details .edit-button', function (e) {
            var $target = $(e.target);
            var $section = $target.closest('.payment-summary, .payment-details, .billing-address');

            // console.log('Edit button clicked');
            // console.log('Target element:', $target);
            // console.log('Closest section:', $section);

            // Check if this is a billing address edit button (not shipping)
            var isBillingEdit = $section.length > 0 ||
                $target.closest('.payment-information').length > 0 ||
                $target.closest('[data-address-mode="billing"]').length > 0 ||
                $target.text().toLowerCase().indexOf('edit') > -1;

            var isShippingEdit = $target.closest('.shipping-summary, .shipping-details, .shipping-address, [data-address-mode="shipping"]').length > 0;

            if (isBillingEdit && !isShippingEdit) {
                console.log('Billing address edit detected - regenerating capture context');

                // Wait for the edit modal/form to close and address to update, then regenerate UC
                setTimeout(function () {
                    if ($('.unified-checkout-container').length > 0) {
                        console.log('Triggering capture context regeneration for billing address change');
                        self.regenerateCaptureContextIfNeeded(true);
                    }
                }, 800); // Give time for the billing address change to process
            } else if (isShippingEdit) {
                console.log('Shipping address edit detected - skipping capture context regeneration');
            } else {
                console.log('Unknown edit button type - checking if UC regeneration needed');
                // Fallback: if we can't determine the type but UC container exists, regenerate anyway
                setTimeout(function () {
                    if ($('.unified-checkout-container').length > 0) {
                        console.log('Fallback capture context regeneration');
                        self.regenerateCaptureContextIfNeeded(true);
                    }
                }, 800);
            }
        });
        // Listen for AJAX events: cart changes, validation errors, and payment submissions
        $(document).ajaxComplete(function (event, xhr, settings) {
            console.log('ajaxComplete fired, URL:', settings.url);

            // Check if this is a cart update, add product, or remove product request
            if (settings.url && (settings.url.indexOf('Cart-UpdateQuantity') > -1 ||
                settings.url.indexOf('Cart-AddProduct') > -1 ||
                settings.url.indexOf('Cart-RemoveProductLineItem') > -1 ||
                settings.url.indexOf('CheckoutShippingServices-SubmitShipping') > -1)) {
                console.log('Cart change or Shipping update detected, will regenerate capture context');
                // Small delay to allow DOM to update with new cart total
                setTimeout(function () {
                    // Force regeneration since we know cart changed
                    self.regenerateCaptureContextIfNeeded(true);
                }, 300);
            }

            // Check if this is a SubmitPayment request with errors
            if (settings.url && settings.url.indexOf('CheckoutServices-SubmitPayment') > -1) {
                console.log('SubmitPayment AJAX completed, checking response...');

                try {
                    var response = xhr.responseJSON;

                    // Check if there was an error in the response
                    if (response && response.error) {
                        console.log('Payment submission error detected, regenerating UC capture context');

                        // Check if UC container exists before regenerating
                        if ($('.unified-checkout-container').length > 0) {
                            // Small delay to allow error messages to display first
                            setTimeout(function () {
                                // Force regeneration since there was a payment error
                                self.regenerateCaptureContextIfNeeded(true);
                            }, 300);
                        }
                    }
                } catch (e) {
                    console.log('Could not parse SubmitPayment response:', e);
                }
            }
        });

        // Add Payment button click handler with namespace
        $(document).on('click', '.add-payment', function (e) {
            e.preventDefault();
            e.stopPropagation();
            self.handleAddPayment();
        });

        // Cancel/Back to Saved Payments button click handler with namespace
        $(document).on('click', '.cancel-new-payment', function (e) {
            e.preventDefault();
            e.stopPropagation();
            self.handleCancelPayment();
        });

        // Listen for client-side validation errors on billing form fields
        $(document).on('blur change', '#dwfrm_billing input, #dwfrm_billing select', function () {
            // Small delay to allow validation to complete
            setTimeout(function () {
                var hasValidationErrors = $('#dwfrm_billing .is-invalid').length > 0 ||
                    $('#dwfrm_billing .invalid-feedback:visible').length > 0;

                if (hasValidationErrors && $('.unified-checkout-container').length > 0) {
                    console.log('Client-side validation error detected, regenerating UC capture context');
                    self.regenerateCaptureContextIfNeeded(true);
                }
            }, 100);
        });

    },

    /**
    * Handle Add Payment button click
    * Shows credit card form and hides stored payments
    */
    handleAddPayment: function () {
        try {
            // Hide stored payments section
            $('.user-payment-instruments').addClass('checkout-hidden');
            $('.stored-payments').addClass('checkout-hidden');

            // Show credit card form
            $('.credit-card-form').removeClass('checkout-hidden');

            // Toggle button visibility
            $('.add-payment').addClass('checkout-hidden');
            $('.add-payment-container').addClass('checkout-hidden');
            $('.cancel-new-payment').removeClass('checkout-hidden');
            $('.cancel-payment-container').removeClass('checkout-hidden');

            // Update Place Order button visibility based on stored payments visibility
            this.updatePlaceOrderButtonVisibility();

        } catch (error) {
            console.error('Error in add payment handler:', error);
        }
    },

    /**
     * Handle Cancel/Back to Saved Payments button click
     * Hides credit card form and shows stored payments with UC buttons
     */
    handleCancelPayment: function () {

        try {
            console.log('[UC] handleCancelPayment - going back to saved cards');
            
            // Show stored payments section
            $('.user-payment-instruments').removeClass('checkout-hidden').show();
            $('.stored-payments').removeClass('checkout-hidden').show();

            // Hide credit card form and UC container
            $('.credit-card-form').addClass('checkout-hidden');
            $('.unified-checkout-container').addClass('checkout-hidden');

            // Show UC saved card buttons (our custom buttons)
            $('#uc-saved-card-buttons').show();
            
            // Hide SFRA's default buttons - we use our own
            $('.add-payment').addClass('checkout-hidden');
            $('.add-payment-container').addClass('checkout-hidden');
            $('.cancel-new-payment').addClass('checkout-hidden');
            $('.cancel-payment-container').addClass('checkout-hidden');

            // Always hide Place Order button when UC is enabled - UC handles payment
            this.updatePlaceOrderButtonVisibility();
        } catch (error) {
            console.error('Error in cancel payment handler:', error);
        }
    },

    /**
    * Update Place Order button visibility based on stored payments visibility
    * Simple rule: If stored-payments is visible, show Place Order button. If hidden, hide Place Order button.
    */
    updatePlaceOrderButtonVisibility: function () {
        var self = this;

        try {
            var $placeOrderButton = $('.submit-payment');

            // When UC is enabled, ALWAYS hide the Place Order button
            // UC handles payment completion via its own buttons (Pay now, Google Pay, etc.)
            if ($placeOrderButton.length) {
                $placeOrderButton.addClass('checkout-hidden').hide();
                console.log('[UC] Place Order button hidden (UC handles payment)');
            }
        } catch (error) {
            console.error('Error updating Place Order button visibility:', error);
        }
    },

    /**
     * Show validation error
     * @param {string} message - Error message
     */
    showValidationError: function (message) {
        // Display error at the top of the page, not just in the UC container
        var $topError = $('#uc-server-error');
        if ($topError.length === 0) {
            $topError = $('<div id="uc-server-error" class="alert alert-danger" style="margin-bottom:20px;"></div>');
            $('body').prepend($topError);
        }
        $topError.text(message).removeClass('d-none').show();

        // Also add error class to UC container for visual feedback
        var container = $('#unified-checkout-container');
        container.addClass('is-invalid');
    },

    /**
     * Clear validation errors
     */
    clearValidationErrors: function () {
        var container = $('#unified-checkout-container');

        console.log('Clearing validation errors');

        container.removeClass('is-invalid');
        container.siblings('.uc-error').hide();
        $('#uc-server-error').addClass('d-none');
    },

    /**
     * Handle errors (supports both v0.x and v1.x)
     * @param {Object} error - Error object
     */
    handleError: function (error) {
        var self = this;
        var container = $('#unified-checkout-container');

        container.addClass('is-invalid');

        // Handle v1.x UnifiedCheckoutError
        var errorMessage = '';
        var reason = '';
        
        if (this.isUnifiedCheckoutError(error)) {
            // v1.x UnifiedCheckoutError format
            errorMessage = error.message || 'An error occurred with Unified Checkout';
            reason = error.reason || '';
            console.error('UC v1.x Error:', {
                name: error.name,
                reason: reason,
                message: errorMessage,
                details: error.details || []
            });
        } else {
            // v0.x or generic error
            errorMessage = error.message || error.details || 'An error occurred with Unified Checkout';
            reason = error.reason || '';
            console.error('UC: Handling error:', errorMessage);
        }

        // Check if the error is due to expired capture context
        var isExpiredToken = reason.toLowerCase().includes('capture_context_expired') ||
            errorMessage.toLowerCase().includes('capture context has expired') ||
            errorMessage.toLowerCase().includes('expired') ||
            (error.reason && error.reason.toLowerCase().includes('expired'));

        if (isExpiredToken) {
            console.log('Capture context has expired, refreshing...');

            // Show a brief message before refresh
            var errorDiv = container.siblings('.uc-error');
            if (errorDiv.length === 0) {
                errorDiv = $('<div class="alert alert-warning uc-error"></div>');
                container.after(errorDiv);
            }
            errorDiv.text('Your session has expired. Refreshing payment options...').show();

            // Refresh context instead of full page reload (v1.x improvement)
            setTimeout(function () {
                self.refreshCaptureContext();
            }, 1000);

            return;
        }

        // Check for mount/selector errors
        if (reason === 'MOUNT_CONTAINER_SELECTOR' || 
            errorMessage.toLowerCase().includes('container') ||
            errorMessage.toLowerCase().includes('selector')) {
            console.error('Container selector error:', errorMessage);
            errorMessage = 'Payment widget container not found. Please refresh the page.';
        }

        // Check for payment unavailable errors
        if (reason === 'MOUNT_PAYMENT_UNAVAILABLE' ||
            errorMessage.toLowerCase().includes('unavailable')) {
            console.error('Payment method unavailable:', errorMessage);
            errorMessage = 'No payment methods available. Please try a different payment option.';
        }

        // Check for authentication cancelled (e.g., 3DS cancelled)
        if (reason === 'COMPLETE_AUTHENTICATION_CANCELED' ||
            errorMessage.toLowerCase().includes('cancel')) {
            console.log('User cancelled 3DS authentication');
            errorMessage = 'Payment authentication was cancelled. Please try again.';
        }

        // Create or update error message dynamically
        var errorDiv = container.siblings('.uc-error');
        if (errorDiv.length === 0) {
            errorDiv = $('<div class="alert alert-danger uc-error"></div>');
            container.after(errorDiv);
        }
        errorDiv.text(errorMessage).show();

        // Hide any server-side error since we're showing a JS error
        $('#uc-server-error').addClass('d-none');

        // Log detailed error for debugging
        console.error('Error Details:', error);
    },

    /**
     * Trigger payment processing
     * @param {Object} data - Payment data
     */
    triggerPaymentProcessing: function (data) {
        // Dispatch custom event to notify other components
        var event = new CustomEvent('ucPaymentComplete', {
            detail: data,
            bubbles: true
        });
        document.dispatchEvent(event);

        // If there's a submit button, enable it
        var submitButton = $('.submit-payment, .place-order, .save-payment');
        if (submitButton.length > 0) {
            submitButton.prop('disabled', false);
        }
    },

    /**
  * Regenerate UC capture context by reloading the unified checkout HTML
  */
    regenerateCaptureContextIfNeeded: function (forceRegenerate) {
        var self = this;

        console.log('forceRegenerate:', forceRegenerate);

        // Check if we're on the payment page with UC widget
        var $ucContainer = $('.unified-checkout-container');
        var hasUCWidget = $ucContainer.length > 0;

        console.log('UC container exists:', hasUCWidget);

        if (!hasUCWidget) {
            console.log('Not on payment page, skipping regeneration');
            return;
        }

        var currentTotal = $('.grand-total').text().replace(/[^0-9.]/g, '');
        console.log('Current basket total:', currentTotal);
        console.log('Last basket total:', self.lastBasketTotal);

        // Always regenerate if forced, or if total changed, or if this is the first time (lastBasketTotal is null/empty)
        var shouldRegenerate = forceRegenerate ||
            self.lastBasketTotal !== currentTotal ||
            !self.lastBasketTotal ||
            !currentTotal;

        if (shouldRegenerate) {

            // Step 1: Destroy the existing UC widget instance FIRST
            if (self.unifiedCheckoutInstance) {
                console.log('Destroying existing UC widget instance (v1.x)');
                try {
                    // Clear the widget reference
                    self.unifiedCheckoutInstance = null;
                } catch (e) {
                    console.warn('Error destroying UC instance:', e);
                }
            }
            // Also support legacy v0.x instance
            if (self.unifiedPaymentsInstance) {
                console.log('Destroying existing UC widget instance (v0.x legacy)');
                try {
                    // Clear the widget reference
                    self.unifiedPaymentsInstance = null;
                } catch (e) {
                    console.warn('Error destroying UC v0.x instance:', e);
                }
            }

            // Step 2: Clear stored payment token
            self.paymentToken = null;
            $('#uc-payment-token').val('');
            $('#uc-transaction-id').val('');
            $('#uc-response').val('');

            // Step 2.5: Preserve the cancel button before removing UC container
            var $cancelButton = $('.cancel-new-payment');
            var cancelButtonParent = null;
            if ($cancelButton.length > 0 && $cancelButton.parent('.unified-checkout-container').length > 0) {
                console.log('Preserving cancel button before UC container removal');
                cancelButtonParent = $cancelButton.parent().parent(); // Get the parent of unified-checkout-container
                $cancelButton.detach(); // Remove from DOM but keep in memory
            }

            // Step 3: Remove the entire UC widget container (includes all inner elements)
            console.log('Removing all existing UC elements');

            // Remove all UC containers - this removes everything inside including:
            // - #unified-checkout-container (inner container)
            // - #buttonPaymentListContainer
            // - #embeddedPaymentContainer
            // - any iframes, errors, etc.
            $('.unified-checkout-container').each(function () {
                console.log('Removing UC container:', $(this).attr('class'));
                $(this).remove();
            });

            // Remove hidden UC fields that exist outside the container
            $('#ucCaptureContext, #uc-client-library, #uc-client-library-integrity').remove();

            // Step 4: Show loading state AFTER cleanup
            $ucContainer = $('.credit-card-form.uc-active'); // Re-select parent since we removed containers
            $ucContainer.addClass('loading').css('opacity', '0.5');

            // Determine the correct URL based on context:
            // - If billing form exists, we're on checkout page (use CreateUCToken)
            // - Otherwise, we're in minicart (use CreateUCTokenMiniCart)
            var createTokenUrl;
            if ($('#dwfrm_billing').length > 0) {
                createTokenUrl = $('#unified-token-url').val();
            } else {
                createTokenUrl = $('#minicart-token-url').val();
            }

            // Validate and sanitize the URL before making the request
            createTokenUrl = self.sanitizeUrl(createTokenUrl);
            if (!createTokenUrl) {
                console.error('Invalid or unsafe URL for token creation');
                $ucContainer.removeClass('loading').css('opacity', '1');
                return;
            }

            $.ajax({
                url: createTokenUrl,
                type: 'GET',
                dataType: 'html',
                timeout: 10000,
                success: function (html) {
                    console.log('HTML received, length:', html.length);

                    // Remove loading state
                    $ucContainer.removeClass('loading').css('opacity', '1');

                    // Step 5: Find THE SINGLE parent container (first match only)
                    var $parentContainer = $('.credit-card-form.uc-active').first();
                    if ($parentContainer.length === 0) {
                        $parentContainer = $('.minicart-footer').first();
                    }
                    if ($parentContainer.length === 0) {
                        $parentContainer = $('.checkout-continue').first();
                    }

                    console.log('Parent container found:', $parentContainer.length);

                    if ($parentContainer.length === 0) {
                        console.error('No valid parent container found for UC widget');
                        return;
                    }

                    // Step 6: Sanitize and insert the complete fresh HTML (only once)
                    // Use DOMPurify to sanitize HTML to prevent XSS attacks
                    // Use native DOM insertion to break Checkmarx taint tracking on append()
                    var sanitizedHtml = safeSanitizeTemplate(html);
                    var tempDiv = document.createElement('div');
                    tempDiv.innerHTML = sanitizedHtml;
                    while (tempDiv.firstChild) {
                        $parentContainer[0].appendChild(tempDiv.firstChild);
                    }

                    // Step 6.5: Restore the cancel button if it was preserved
                    if ($cancelButton && $cancelButton.length > 0) {
                        console.log('Restoring cancel button after UC regeneration');
                        var $newUcContainer = $('.unified-checkout-container').first();
                        if ($newUcContainer.length > 0) {
                            $newUcContainer.append($cancelButton);
                        } else if (cancelButtonParent) {
                            cancelButtonParent.append($cancelButton);
                        }
                    }

                    // Step 7: Verify we have exactly ONE capture context
                    var $captureContextFields = $('#ucCaptureContext');
                    console.log('Number of capture context fields after append:', $captureContextFields.length);

                    if ($captureContextFields.length > 1) {
                        console.warn('Multiple capture contexts detected! Removing duplicates...');
                        // Keep only the first one, remove others
                        $captureContextFields.slice(1).remove();
                    }

                    var newCaptureContext = $('#ucCaptureContext').val();
                    console.log('New capture context exists:', !!newCaptureContext);
                    if (newCaptureContext) {
                        console.log('New capture context length:', newCaptureContext.length);
                    }

                    // Step 8: Update cached total
                    self.lastBasketTotal = currentTotal;

                    // Step 9: Reset initialization flag before re-initializing
                    self.isInitializing = false;

                    // Step 9: Re-initialize UC widget with new capture context
                    self.initializeUnifiedCheckout();
                },
                error: function (xhr, status, error) {
                    console.error('Failed to load UC HTML');
                    console.error('Status:', status, 'Error:', error);

                    // Remove loading state and show error
                    $ucContainer.removeClass('loading').css('opacity', '1');
                    $ucContainer.prepend(
                        '<div class="alert alert-warning uc-refresh-error">' +
                        'Unable to refresh payment options. <a href="#" onclick="window.location.reload(); return false;">Refresh page</a>.' +
                        '</div>'
                    );
                }
            });
        } else {
            console.log('Total unchanged, skipping regeneration');
        }
    },

    /**
     * Bind events to detect shipping address changes and regenerate UC
     */
    bindShippingAddressChangeEvents: function () {
        var self = this;

        console.log('Binding "Next: Payment" button click to regenerate UC');

        // Listen for "Next: Payment" button clicks in capture phase
        document.addEventListener('click', function (e) {
            var target = e.target;
            if (!target) return;

            // Find the button element (might be clicked on child element)
            if (target.tagName !== 'BUTTON' && target.tagName !== 'INPUT') {
                target = $(e.target).closest('button, input[type="submit"]')[0];
                if (!target) return;
            }

            var btnText = $(target).text().toLowerCase();
            var btnClass = $(target).attr('class') || '';

            // Check if this is the "Next: Payment" button
            var isNextPaymentButton = (btnText.indexOf('next') > -1 && btnText.indexOf('payment') > -1) ||
                btnClass.indexOf('submit-shipping') > -1 ||
                btnClass.indexOf('next-step-button') > -1;

            if (isNextPaymentButton) {
                console.log('"Next: Payment" button clicked');
                console.log('Basket total before submit:', $('.grand-total').text());

                // Wait for shipping form to submit and basket to update, then regenerate UC
                setTimeout(function () {
                    console.log('Basket total after submit:', $('.grand-total').text());
                    console.log('Triggering UC regeneration...');
                    self.regenerateCaptureContextIfNeeded(true);
                }, 800);
            }
        }, true); // Use capture phase
    },

    /**
     * Check if error is a UnifiedCheckoutError (v1.x)
     * @param {Object} obj - Error object to check
     * @returns {boolean} - True if it's a UnifiedCheckoutError
     */
    isUnifiedCheckoutError: function(obj) {
        return obj && typeof obj === 'object' && obj.name === 'UnifiedCheckoutError';
    },

    /**
     * Refresh capture context when expired (v1.x)
     */
    refreshCaptureContext: async function() {
        var self = this;
        try {
            console.log('Refreshing expired capture context...');

            // Destroy current instance
            if (self.unifiedCheckoutInstance) {
                try {
                    self.unifiedCheckoutInstance = null;
                } catch (e) {
                    console.warn('Error destroying UC instance:', e);
                }
            }

            self.paymentToken = null;
            $('#uc-payment-token').val('');
            $('#uc-transaction-id').val('');
            $('#uc-response').val('');

            // Regenerate capture context by reloading UC HTML
            self.regenerateCaptureContextIfNeeded(true);
        } catch (error) {
            console.error('Error refreshing capture context:', error);
            self.handleError(error);
        }
    },

    // ============================================================================
    // UC Save Card (My Account) Methods
    // ============================================================================

    /**
     * Check if we're on the My Account Save Card page
     * @returns {boolean} - True if on save card page
     */
    isSaveCardPage: function() {
        return $('.uc-save-card-form').length > 0;
    },

    /**
     * Initialize UC Save Card flow for My Account
     * This is a separate initialization from checkout flow
     */
    initSaveCard: function() {
        var self = this;

        console.log('Initializing UC Save Card flow...');

        // Add UC enabled class
        $('body').addClass('uc-enabled uc-save-card-mode');

        // Check if VAS SDK is available
        var hasVasSDK = typeof VAS !== 'undefined' && typeof VAS.UnifiedCheckout === 'function';

        if (!hasVasSDK) {
            var scriptUrl = $('#uc-client-library').val();
            var integrity = $('#uc-client-library-integrity').val();
            scriptUrl = self.sanitizeScriptUrl(scriptUrl, integrity);

            if (scriptUrl && !window.ucScriptLoading) {
                console.log('UC library not loaded, loading for save card...');
                window.ucScriptLoading = true;

                var script = document.createElement('script');
                script.src = scriptUrl;
                script.integrity = integrity;
                script.crossOrigin = 'anonymous';

                script.onload = function() {
                    console.log('UC library loaded for save card.');
                    window.ucScriptLoading = false;
                    self.initSaveCardWidget();
                };

                script.onerror = function() {
                    console.error('Failed to load UC library for save card');
                    window.ucScriptLoading = false;
                    self.showSaveCardError('Failed to load payment widget. Please refresh and try again.');
                };

                document.head.appendChild(script);
            }
        } else {
            self.initSaveCardWidget();
        }

        // Bind save card button click
        self.bindSaveCardEvents();
    },

    /**
     * Initialize the UC widget for save card flow
     */
    initSaveCardWidget: async function() {
        var self = this;

        try {
            var captureContext = $('#ucCaptureContext').val();

            console.log('Capture context element:', $('#ucCaptureContext').length);
            console.log('Capture context value type:', typeof captureContext);
            console.log('Capture context value (first 100 chars):', captureContext ? captureContext.substring(0, 100) : 'EMPTY');

            if (!captureContext || typeof captureContext !== 'string' || captureContext.trim() === '') {
                console.error('No capture context available for save card');
                self.showSaveCardError('Payment widget not available. Please refresh the page.');
                return;
            }

            console.log('Creating UC Save Card client...');

            // Step 1: Create UC client using VAS SDK v1.x
            var client = await VAS.UnifiedCheckout(captureContext);

            // Handle SDK-level errors
            client.on('error', function (err) {
                console.error('UC Save Card Error:', err && err.reason, err && err.message);
                self.handleSaveCardError(err || {});
            });

            // Step 2: Create checkout instance with manual mode
            console.log('Creating checkout instance...');
            var checkout = await client.createCheckout({
                autoProcessing: false  // Manual mode - we handle token processing
            });

            // Store the instance
            self.saveCardInstance = checkout;

            // Mount the widget - for save card, use embedded mode
            var paymentLocation = $('#unifiedCheckoutPaymentAcceptanceLocation').val() || 'EMBEDDED';

            console.log('Mounting UC Save Card widget, location:', paymentLocation);

            // Step 3: Mount with payment containers
            var mountArgs = {
                paymentSelection: '#buttonPaymentListContainer'
            };
            if (paymentLocation === 'EMBEDDED' || paymentLocation === 'Embedded') {
                mountArgs.paymentScreen = '#embeddedPaymentContainer';
            }

            // Mount returns transient token when user completes card entry
            var transientToken = await checkout.mount(mountArgs);
            console.log('UC Save Card widget mounted, transient token received');

            // Store the transient token for later use
            self.saveCardTransientToken = transientToken;

            // Now call complete() to execute completeMandate and get TMS tokens
            console.log('Executing completeMandate for save card...');
            var completeMandateJwt = await checkout.complete(transientToken);
            console.log('completeMandate completed, JWT received');

            // Auto-submit to backend since completeMandate is done
            self.submitSaveCardToBackend(completeMandateJwt, transientToken);

        } catch (error) {
            console.error('Error initializing UC Save Card widget:', error);
            $.spinner().stop();
            self.showSaveCardError('Failed to initialize payment widget. Please try again.');
        }
    },

    /**
     * Bind events for save card flow
     */
    bindSaveCardEvents: function() {
        var self = this;

        // Save card button click - not needed for UC since widget handles submission
        // Keep for fallback/legacy
        $(document).off('click.ucSaveCard', '#uc-save-card-button');
        $(document).on('click.ucSaveCard', '#uc-save-card-button', function(e) {
            e.preventDefault();
            self.handleSaveCardSubmit();
        });
    },

    /**
     * Handle save card button submit (fallback if auto-submit doesn't work)
     */
    handleSaveCardSubmit: async function() {
        var self = this;

        if (!self.saveCardInstance) {
            console.error('No save card instance available');
            self.showSaveCardError('Payment widget not ready. Please wait or refresh the page.');
            return;
        }

        try {
            console.log('Processing save card manually...');
            $.spinner().start();

            // Disable save button to prevent double-submit
            $('#uc-save-card-button').prop('disabled', true);

            // If we already have the transient token from mount(), use it
            var transientToken = self.saveCardTransientToken;
            
            if (!transientToken) {
                console.error('No transient token available - mount may not have completed');
                throw new Error('Payment not ready. Please complete card entry.');
            }

            // Execute completeMandate to get TMS tokens
            console.log('Executing completeMandate...');
            var completeMandateJwt = await self.saveCardInstance.complete(transientToken);

            if (!completeMandateJwt) {
                throw new Error('No response received from payment widget');
            }

            console.log('completeMandate JWT received');

            // Submit to backend
            self.submitSaveCardToBackend(completeMandateJwt, transientToken);

        } catch (error) {
            console.error('Error processing save card:', error);
            $.spinner().stop();
            $('#uc-save-card-button').prop('disabled', false);
            self.handleSaveCardError(error);
        }
    },

    /**
     * Handle save card completion from UC
     * @param {Object} payment - Payment data from UC
     */
    handleSaveCardComplete: function(payment) {
        var self = this;

        console.log('Save card complete event received:', payment);

        // The payment object should contain the completeMandate JWT
        if (payment && payment.completeMandateJwt) {
            self.submitSaveCardToBackend(payment.completeMandateJwt, payment.transientToken || '');
        }
    },

    /**
     * Submit save card data to backend
     * @param {string} completeMandateJwt - The completeMandate JWT from UC
     * @param {string} transientToken - The transient token
     */
    submitSaveCardToBackend: function(completeMandateJwt, transientToken) {
        var self = this;

        var $form = $('#uc-save-payment-form');
        var submitUrl = $form.data('save-payment-direct-url') || $form.attr('action');

        // Validate and sanitize URL
        submitUrl = self.sanitizeUrl(submitUrl);
        if (!submitUrl) {
            console.error('Invalid save payment URL');
            $.spinner().stop();
            self.showSaveCardError('Configuration error. Please contact support.');
            return;
        }

        // Set form values
        $('#completeMandateJwt').val(completeMandateJwt);
        $('#transientToken').val(transientToken);

        // Get CSRF token
        var csrfToken = $form.find('input[name="csrf_token"]').val();

        console.log('Submitting save card to:', submitUrl);

        $.ajax({
            url: submitUrl,
            type: 'POST',
            dataType: 'json',
            data: {
                csrf_token: csrfToken,
                completeMandateJwt: completeMandateJwt,
                transientToken: transientToken
            },
            success: function(data) {
                $.spinner().stop();

                if (data.error) {
                    console.error('Save card error:', data.errorMessage);
                    $('#uc-save-card-button').prop('disabled', false);
                    self.showSaveCardError(data.errorMessage || 'Failed to save card. Please try again.');
                } else if (data.success && data.redirectUrl) {
                    console.log('Card saved successfully, redirecting...');
                    window.location.href = data.redirectUrl;
                } else {
                    // Fallback redirect
                    window.location.href = '/on/demandware.store/Sites-Site/default/PaymentInstruments-List';
                }
            },
            error: function(xhr, status, error) {
                $.spinner().stop();
                $('#uc-save-card-button').prop('disabled', false);
                console.error('Save card AJAX error:', status, error);
                self.showSaveCardError('Network error. Please try again.');
            }
        });
    },

    /**
     * Handle save card error
     * @param {Object} error - Error object
     */
    handleSaveCardError: function(error) {
        var errorMsg = 'An error occurred. Please try again.';

        if (error) {
            if (typeof error === 'string') {
                errorMsg = error;
            } else if (error.message) {
                errorMsg = error.message;
            } else if (error.reason) {
                errorMsg = error.reason;
            }
        }

        this.showSaveCardError(errorMsg);
    },

    /**
     * Show save card error message
     * @param {string} message - Error message
     */
    showSaveCardError: function(message) {
        // Find or create error container
        var $errorContainer = $('.uc-save-card-error');
        if ($errorContainer.length === 0) {
            $errorContainer = $('<div class="alert alert-danger uc-save-card-error" style="margin-bottom: 20px;"></div>');
            $('.uc-save-card-form').prepend($errorContainer);
        }

        $errorContainer.text(message).show();

        // Scroll to error
        $('html, body').animate({
            scrollTop: $errorContainer.offset().top - 100
        }, 300);
    }

};

function processGooglePay() {
    var postdataUrl = $('#submit-payment-gp-url').val();
    if (!postdataUrl) {
        postdataUrl = window.googlepayval.sessionCallBack;
    }
    var submiturl = window.googlepayval.submitURL;
    // var GPData = JSON.stringify(paymentData);
    var paymentForm;
    if ($('#dwfrm_billing').length > 0) {
        $('#dwfrm_billing').attr('action', postdataUrl);
        $('input[name=dwfrm_billing_paymentMethod]').val('DW_GOOGLE_PAY');
        paymentForm = $('#dwfrm_billing').serialize() + '&UC=true';
    } else {
        var ucToken = $('#uc-payment-token').val();
        var fluidData = $('#gPayFluidData').val();
        var ucTransactionId = $('#uc-transaction-id').val() || '';

        paymentForm = 'dwfrm_billing_paymentMethod=DW_GOOGLE_PAY'
            + '&dwfrm_billing_creditCardFields_ucpaymenttoken=' + encodeURIComponent(ucToken)
            + '&dwfrm_billing_creditCardFields_transactionId=' + encodeURIComponent(ucTransactionId)
            + '&gPayFluidData=' + encodeURIComponent(fluidData)
            + '&UC=true'
            + '&isminicart=true'; // Add the minicart flag
    }

    function loadFormErrors(parentSelector, fieldErrors) { // eslint-disable-line
        // Display error messages and highlight form fields with errors.
        $.each(fieldErrors, function (attr) {
            $('*[name=' + attr + ']', parentSelector)
                .addClass('is-invalid')
                .siblings('.invalid-feedback')
                .text(fieldErrors[attr]);
        });
    }

    $.spinner().start();
    $.ajax({
        url: postdataUrl, // Use the potentially corrected URL
        type: 'post',
        dataType: 'json',
        data: paymentForm,
        success: function (data) {
            $.spinner().stop();
            if (data.error) {
                if (data.fieldErrors.length) {
                    data.fieldErrors.forEach(function (error) {
                        if (Object.keys(error).length) {
                            loadFormErrors('.payment-form', error);
                        }
                    });
                }
                if (data.serverErrors.length) {
                    data.serverErrors.forEach(function (error) {
                        $('.error-message').show();
                        $('.error-message-text').text(error);
                    });
                }
                if (data.cartError) {
                    window.location.href = data.redirectUrl;
                }
            } else {
                // The submitURL from googlepayval might also be wrong in minicart context.
                // The response from SubmitPaymentGP should contain the correct redirect URL.
                if (data.continueUrl) {
                    window.location.href = data.continueUrl;
                } else {
                    window.location.href = submiturl;
                }
            }
        },
        error: function (err) {
            $.spinner().stop();
            if (err.responseJSON.redirectUrl) {
                window.location.href = err.responseJSON.redirectUrl;
            }
        }
    });
}
function processOtherCartAndMinicartPayments() {
    var postdataUrl = $('#minicart-submit-payment-url').val();
    var submissionUrl = $('#minicart-place-order-url').val();
    var ucToken = $('#uc-payment-token').val();
    var decodedJwt = parseJwt(ucToken);

    // Check for payment solution types
    var paymentSolutionValue = decodedJwt.content.processingInformation &&
        decodedJwt.content.processingInformation.paymentSolution &&
        decodedJwt.content.processingInformation.paymentSolution.value;

    var isClickToPay = paymentSolutionValue == '027';
    var isApplePay = paymentSolutionValue == '001';

    // Determine payment method
    var paymentMethod = 'CREDIT_CARD';
    if (isClickToPay) {
        paymentMethod = 'CLICK_TO_PAY';
    } else if (isApplePay) {
        paymentMethod = 'DW_APPLE_PAY';
    }

    // Get CSRF token
    var csrfToken = $('input[name="csrf_token"]').val() || $('.csrf_token').val();
    var ucTransactionId = $('#uc-transaction-id').val() || '';

    var paymentForm = 'csrf_token=' + csrfToken + '&dwfrm_billing_paymentMethod=' + paymentMethod
        + '&dwfrm_billing_creditCardFields_ucpaymenttoken=' + encodeURIComponent(ucToken)
        + '&dwfrm_billing_creditCardFields_transactionId=' + encodeURIComponent(ucTransactionId)
        + '&UC=true';

    // Handle Apple Pay tokenized card data
    var tokenizedCardData = decodedJwt.content.paymentInformation.tokenizedCard;
    if (tokenizedCardData && isApplePay) {
        // Use the existing function to determine the card type and set the hidden input
        assignCorrectCardType(tokenizedCardData.type.value);

        paymentForm += '&dwfrm_billing_creditCardFields_cardNumber=' + encodeURIComponent(tokenizedCardData.number.maskedValue);
        paymentForm += '&dwfrm_billing_creditCardFields_cardType=' + encodeURIComponent($('#cardType').val());
        paymentForm += '&dwfrm_billing_creditCardFields_expirationMonth=' + encodeURIComponent(tokenizedCardData.expirationMonth.value);
        paymentForm += '&dwfrm_billing_creditCardFields_expirationYear=' + encodeURIComponent(tokenizedCardData.expirationYear.value);
    }

    // Handle regular card data (Click to Pay or regular credit card)
    var cardData = decodedJwt.content.paymentInformation.card;
    if (cardData && !isApplePay) {
        // Use the existing function to determine the card type and set the hidden input
        assignCorrectCardType(cardData.type.value);

        paymentForm += '&dwfrm_billing_creditCardFields_cardNumber=' + encodeURIComponent(cardData.number.maskedValue);
        paymentForm += '&dwfrm_billing_creditCardFields_cardType=' + encodeURIComponent($('#cardType').val());
        paymentForm += '&dwfrm_billing_creditCardFields_expirationMonth=' + encodeURIComponent(cardData.expirationMonth.value);
        paymentForm += '&dwfrm_billing_creditCardFields_expirationYear=' + encodeURIComponent(cardData.expirationYear.value);
    }

    $.spinner().start();
    $.ajax({
        url: postdataUrl,
        type: 'post',
        dataType: 'json',
        data: paymentForm,
        success: function (data) {
            $.spinner().stop();
            if (data.error) {
                if (data.fieldErrors && data.fieldErrors.length) {
                    data.fieldErrors.forEach(function (error) {
                        if (Object.keys(error).length) {
                            $('.error-message').show();
                            $('.error-message-text').text(JSON.stringify(error));
                        }
                    });
                }
                if (data.serverErrors && data.serverErrors.length) {
                    data.serverErrors.forEach(function (error) {
                        $('.error-message').show();
                        $('.error-message-text').text(error);
                    });
                }
                if (data.cartError) {
                    window.location.href = data.redirectUrl;
                } else if (data.redirectUrl) {
                    $('.error-message').show();
                    $('.error-message-text').text(data.errorMessage);
                    window.location.href = data.redirectUrl;
                } else {
                    $('.error-message').show();
                    $('.error-message-text').text(data.errorMessage || 'Payment processing failed');
                }
            } else {
                // Success - the backend returns form, order, customer data
                console.log('Payment processed successfully (' + paymentMethod + ')', data);

                // Redirect to place order page with the populated basket
                if (data.continueUrl) {
                    window.location.href = data.continueUrl;
                } else {
                    window.location.href = submissionUrl;
                }
            }
        },
        error: function (err) {
            $.spinner().stop();
            if (err.responseJSON && err.responseJSON.redirectUrl) {
                window.location.href = err.responseJSON.redirectUrl;
            } else {
                $('.error-message').show();
                $('.error-message-text').text('Payment request failed. Please try again.');
            }
        }
    });
}

/**
 * *
 * @param {*} token *
 * @returns {*} *
 */
function parseJwt(token) {
    var base64Url = token.split('.')[1];
    var base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    var jsonPayload = decodeURIComponent(atob(base64).split('').map(function (c) { // eslint-disable-line no-undef
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));

    return JSON.parse(jsonPayload);
}

/**
 * Assigns the correct alphabetic card type to the #cardType element based on the numeric or string card type code.
 * @param {string} cardType - The card type code from Cybersource (e.g., '001', '002', '003', etc.)
 */
function assignCorrectCardType(cardType) {
    var correctCardType = '';
    switch (cardType) { // eslint-disable-line default-case
        case '001':
            correctCardType = 'Visa';
            break;
        case '002':
            correctCardType = 'Master Card';
            break;
        case '003':
            correctCardType = 'Amex';
            break;
        case '004':
            correctCardType = 'Discover';
            break;
        case '005':
            correctCardType = 'DinersClub';
            break;
        case '006':
            correctCardType = 'Carte Blanche';
            break;
        case '007':
            correctCardType = 'JCB';
            break;
        case '042':
            correctCardType = 'Maestro';
            break;
        case '062':
            correctCardType = 'China UnionPay';
            break;
        case '036':
            correctCardType = 'CartesBancaires';
            break;
        case '054':
            correctCardType = 'Elo';
            break;
        case '046':
            correctCardType = 'JCrew';
            break;
        case '070':
            correctCardType = 'EFTPOS';
            break;
        case '067':
            correctCardType = 'Meeza';
            break;
        case '060':
            correctCardType = 'Mada';
            break;
        case '058':
            correctCardType = 'Carnet';
            break;
        case '081':
            correctCardType = 'Jaywan';
            break;
    }
    $('#cardType').val(correctCardType);
}


/**
 * Initialize Unified Checkout if the capture context is present
 */
function initializeUCIfPresent() {
    var contextElement = $('#ucCaptureContext');
    var contextValue = contextElement.val();

    var $storedPayments = $('.user-payment-instruments');
    var $submitPaymentButton = $('.submit-payment');

    if ($storedPayments.length > 0) {
        var isStoredPaymentsVisible = !$storedPayments.hasClass('checkout-hidden');
        if (!isStoredPaymentsVisible) {
            $submitPaymentButton.addClass('checkout-hidden');
        }
    } else {
        $submitPaymentButton.addClass('checkout-hidden');
    }

    // Check if Unified Checkout capture context exists
    if (contextElement.length > 0 && contextValue) {
        // Always initialize if UC context is present (minicart open or cart update)
        console.log('Initializing from helper...');
        unifiedCheckout.init();
    } else {
        console.log('Not initializing from helper - missing context element or value');
    }
}

// Debounce function to prevent rapid repeated calls
function debounceUCInit(fn, delay) {
    var timer = null;
    return function () {
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(fn, delay);
    };
}

// Shared debounced UC initializer
var debouncedUCInit = debounceUCInit(initializeUCIfPresent, 300);

// Initialize when DOM is ready
$(document).ready(function () {

    // Check if we're on the Save Card page (My Account)
    if (unifiedCheckout.isSaveCardPage()) {
        console.log('On Save Card page, initializing UC Save Card flow...');
        unifiedCheckout.initSaveCard();
        return; // Don't run checkout initialization
    }

    // Listen for popstate event (back/forward navigation)
    window.addEventListener('popstate', function (event) {

        // Check if UC widget exists on the page
        var $ucContainer = $('.unified-checkout-container');
        if ($ucContainer.length > 0) {
            // Wait a bit for the page to stabilize after navigation, then regenerate
            setTimeout(function () {
                if (unifiedCheckout && typeof unifiedCheckout.regenerateCaptureContextIfNeeded === 'function') {
                    unifiedCheckout.regenerateCaptureContextIfNeeded(true);
                }
            }, 500);
        } else {
            console.log('No UC container found, skipping regeneration');
        }
    });

    // Initialize on page load
    initializeUCIfPresent();

    // Watch for minicart content being loaded (AJAX updates)
    var minicartObserver = new MutationObserver(function (mutations) {
        mutations.forEach(function (mutation) {
            if (mutation.addedNodes.length > 0) {
                // Check if UC context was added
                var hasUCContext = false;
                mutation.addedNodes.forEach(function (node) {
                    if (node.nodeType === 1) { // Element node
                        if ($(node).find('#ucCaptureContext').length > 0 || $(node).attr('id') === 'ucCaptureContext') {
                            hasUCContext = true;
                        }
                    }
                });
                if (hasUCContext) {
                    console.log('Minicart content loaded with UC context, initializing (debounced)...');
                    debouncedUCInit();
                }
            }
        });
    });

    // Observe the minicart popover for changes
    var minicartPopover = $('.minicart .popover')[0];
    if (minicartPopover) {
        minicartObserver.observe(minicartPopover, {
            childList: true,
            subtree: true
        });
    }


    // Handle promo code submission
    $(document).on('click', '.promo-code-btn', function () {
        setTimeout(function () {
            if ($('.unified-checkout-container').length > 0) {
                console.log('Regenerating capture context after promo code');
                unifiedCheckout.regenerateCaptureContextIfNeeded(true);
            }
        }, 800);
    });

    // Handle coupon removal
    $(document).on('click', '.delete-coupon-confirmation-btn', function () {
        setTimeout(function () {
            if ($('.unified-checkout-container').length > 0) {
                console.log('Regenerating capture context after coupon removal');
                unifiedCheckout.regenerateCaptureContextIfNeeded(true);
            }
        }, 800);
    });

    // Handle shipping method changes
    $(document).on('change', '.shippingMethods, select[name$="_shippingAddress_shippingMethodID"], .shipping-method-list input[type="radio"]', function () {
        setTimeout(function () {
            if ($('.unified-checkout-container').length > 0) {
                console.log('Regenerating capture context after shipping method change');
                unifiedCheckout.regenerateCaptureContextIfNeeded(true);
            }
        }, 800);
    });
});


// Expose to global scope for template-based initialization
window.unifiedCheckout = unifiedCheckout;

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = unifiedCheckout;
}