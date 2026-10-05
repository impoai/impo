# Product discovery

Impo exposes `impo_search_products` and `impo_get_product` as read-only Rebyte function tools. Impo's worker executes them through the existing durable invocation/receipt path and calls Shopify's public Catalog UCP MCP endpoint. Country (ISO alpha-2), language (BCP 47), currency (ISO 4217), and optional minimum/maximum prices are validated on the server. Prices use currency minor units, including zero-decimal JPY and three-decimal KWD. Size, color and other preferences go in the search query. Country is a requested market, not a verified shipping address.

Shopify may ignore filters or return another currency. Impo omits unavailable search results and independently excludes out-of-budget or differently denominated products when a budget is present. A requested language does not guarantee translated merchant content. Catalog coverage is limited to eligible Shopify merchants; delivery and final store prices are not guaranteed.

Completed catalog function results become versioned `data-impo-products` stream parts:

```json
{
  "type": "data-impo-products",
  "id": "function_output_id",
  "data": {
    "schemaVersion": 1,
    "selectionId": "function_output_id",
    "productIds": ["gid://shopify/p/product_id"],
    "query": "commuter backpack",
    "context": { "address_country": "US", "language": "en", "currency": "USD" },
    "priceFilter": { "max": 15000 }
  }
}
```

Only completed catalog calls and their corresponding function outputs can create references. Rebyte retains canonical tool history; Impo rebuilds the same references for replay and conversation history. Product descriptions and prices are not copied into a new product database or native conversation cache.

`GET /api/v1/messages/{assistantMessageId}/products?selectionId={selectionId}` resolves a selection through the authenticated user's owned submission and Rebyte session, then reads current products using `lookup_catalog`. Optional `productId` must belong to that exact selection and uses `get_product`. The response contains `products`, `context`, and `fetchedAt`, with `Cache-Control: no-store`. Budget constraints apply again on refresh. Missing ownership or membership returns 404; unauthenticated requests return 401; catalog outages return retryable 503. Product images use HTTPS Shopify CDN URLs; merchant links must be HTTPS URLs without credentials.

The iOS client renders product cards in main chat and task conversations, with images, merchant names, current prices, a refreshed detail sheet, product options, and a user-initiated link to the merchant. Loading, empty, unavailable and retry states are explicit. Device locale provides suggested country/language/currency; explicit user requests override it. Older clients ignore the optional data part and continue showing the agent's answer. Android product cards are not implemented in this release.

This release performs no cart, checkout, order, payment or purchase authorization operations. Impo publishes its read-only UCP profile at `/.well-known/ucp` under its configured API deployment prefix. Discovery uses a versioned URL and `Cache-Control: public, max-age=3600`; the required `payment_handlers` registry is empty. Product responses remain `no-store`. Direct Rebyte MCP discovery was tested but tool execution failed in the provider; the release uses Impo-managed functions.
