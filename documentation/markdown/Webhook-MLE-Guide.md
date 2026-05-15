# Unified Checkout Webhooks: Message-Level Encryption (MLE) Guide

This document provides a step-by-step guide for configuring Asymmetric Message-Level Encryption (MLE) specifically for **Unified Checkout (UC) Webhooks** in Salesforce B2C Commerce.

Unlike standard API MLE (which uses CyberSource's public certificate to encrypt *outbound* requests), UC Webhook MLE requires you to generate your own key pair. CyberSource uses your Public Key to encrypt *inbound* webhook notifications, and Salesforce B2C Commerce uses your Private Key to decrypt them.

---

## Step 1: Generate an Egress Key Pair

You must generate an RSA 2048-bit key pair (a Private Key and a Certificate Signing Request (CSR)). 

1. Open your terminal or command prompt.
2. Execute the following OpenSSL command (replace `YOUR_MID` with your actual CyberSource Merchant ID):

```bash
openssl req -new -newkey rsa:2048 -nodes -keyout egress_mle_key.pem -subj "/CN=YOUR_MID" -out egress_mle.csr && echo Private Key (Base64): && openssl pkcs8 -topk8 -inform PEM -in egress_mle_key.pem -outform DER -nocrypt | openssl base64 -A && echo. && echo CSR (Base64): && openssl req -inform PEM -in egress_mle.csr -outform DER | openssl base64 -A
```

3. Save the **Private Key (Base64)** and the **CSR (Base64)** strings from the terminal output. You will need them for the next steps.

---

## Step 2: Create a `.p12` Keystore for Salesforce B2C Commerce

Salesforce B2C Commerce requires a PKCS#12 (`.p12`) file to securely store your Private Key for decryption.

1. Using the `egress_mle_key.pem` generated in Step 1, run the following OpenSSL command to package it into a `.p12` file. (You will be prompted to create an Export Password. Remember this password).

```bash
openssl pkcs12 -export -inkey egress_mle_key.pem -in egress_mle.csr -out webhook_egress.p12 -name "Cybersource_Webhook_Egress"
```

2. Log in to Salesforce **Business Manager**.
3. Navigate to **Administration > Operations > Private Keys and Certificates**.
4. Click **Import** and upload the `webhook_egress.p12` file using the Export Password you created.
5. Make a note of the **Alias** assigned to this key (e.g., `Cybersource_Webhook_Egress`).

---

## Step 3: Register the CSR in CyberSource Enterprise Business Center (EBC)

You must provide your CSR to CyberSource so they can generate the Public Key they will use to encrypt your webhooks.

1. Log in to the **CyberSource Enterprise Business Center (EBC)**.
2. Navigate to **Payment Configuration > Key Management**.
3. Click **Generate Key** and select **REST API Response MLE Key**.
4. Paste the **CSR (Base64)** string generated in Step 1.
5. Click Submit/Generate. 
6. Download the resulting `certChain.pem` file.

---

## Step 4: Extract the Egress Public Key

CyberSource bundles multiple certificates into the `certChain.pem` file. You only need the first Public Key.

1. Open the downloaded `certChain.pem` file in a text editor.
2. Locate the **first** block of text enclosed by:
   `-----BEGIN PUBLIC KEY-----`
   `-----END PUBLIC KEY-----`
3. Copy this entire block (including the BEGIN and END headers).

---

## Step 5: Configure Webhook Manager in Salesforce B2C Commerce

Now you will bind the keys together using the custom CyberSource Webhook Manager.

1. In Salesforce **Business Manager**, navigate to **Merchant Tools > Custom Modules > CyberSource Webhook Manager** (or navigate to the route `WebhookManager-Show` in your browser).
2. Scroll down to the **Advanced Configuration** section.
3. In the **Egress MLE Private Key Alias** field, enter the alias from Step 2 (e.g., `Cybersource_Webhook_Egress`).
4. In the **Egress Public Key (from certChain.pem)** field, paste the exact Public Key block copied in Step 4.
5. Click **Update Advanced Settings**.

### What happens in the background?
When you click Update, the cartridge securely communicates with CyberSource. It calls `POST /kms/egress/v2/keys-asym` to upload your Public Key. CyberSource immediately configures your Unified Checkout Webhook (`uc.orders.transactionresults`) to encrypt all future payloads using that Public Key. 

When a webhook arrives, the SFCC controller will automatically use your Private Key Alias to decrypt the JWE payload.

---

## Appendix: Webhook MLE vs. API MLE

It is important to understand that Webhook MLE operates in the opposite direction of standard API MLE.

*   **API MLE (Standard Calls):** Uses the `CyberSource_SJC_US` Certificate (`.crt`) extracted via OpenSSL from the CyberSource-generated `.p12`. This is used to encrypt outbound requests sent *to* CyberSource.
*   **Webhook MLE:** Uses your own custom-generated `.p12` Private Key to decrypt inbound asynchronous notifications sent *from* CyberSource. They are separate cryptographic flows.
