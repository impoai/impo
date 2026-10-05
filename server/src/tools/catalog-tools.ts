import { ServiceError } from '../errors.js';
import { catalogContext, catalogProducts, catalogRequest, object, withinBudget, type PriceFilter } from '../commerce/catalog.js';
import { ToolRegistry } from './registry.js';
import { jsonValue } from './device-tools.js';

const invalid = (): never => { throw new ServiceError(422, 'invalid_tool_arguments', 'Use a valid query or product ID, country, language, currency and price range.'); };
const contextProperties = {
  country: { type: 'string', pattern: '^[A-Z]{2}$', description: 'Destination country, ISO alpha-2. Also filters delivery eligibility.' },
  language: { type: 'string', description: 'Preferred product language, BCP 47, such as en or zh-Hans.' },
  currency: { type: 'string', pattern: '^[A-Z]{3}$', description: 'Requested currency, such as USD, EUR or JPY. Use the actual returned currency.' },
};

export function catalogToolRegistry(profileURL?: string): ToolRegistry {
  return new ToolRegistry(['impo_search_products', 'impo_get_product'].map(name => {
    const search = name === 'impo_search_products';
    return { name, version: 1, family: 'external' as const, executionLocation: 'server' as const, retry: 'read-only' as const, timeoutMs: 20_000,
      description: search ? 'Search real products across Shopify merchants. Returns up to six products with merchant links and native product cards. Provide country, language, currency and optional price bounds. Add size, color and other preferences to the search query. This is a read-only catalog, not the entire web.'
        : 'Read current product details and available options for a Shopify product ID returned by impo_search_products. This is read-only and creates a product card.',
      parameters: { type: 'object', properties: { ...contextProperties, ...(search ? {
        query: { type: 'string', minLength: 1, maxLength: 500 },
        minPrice: { type: 'integer', minimum: 0, description: 'Minimum in minor units of the requested currency.' },
        maxPrice: { type: 'integer', minimum: 0, description: 'Maximum in minor units of the requested currency.' },
      } : { productId: { type: 'string', description: 'Exact gid://shopify/ product ID from an earlier catalog result.' } }) }, required: [search ? 'query' : 'productId'], additionalProperties: false },
      validate(value: unknown) {
        jsonValue(value); const input = object(value);
        const allowed = [...Object.keys(contextProperties), ...(search ? ['query', 'minPrice', 'maxPrice'] : ['productId'])];
        if (Object.keys(input).some(key => !allowed.includes(key))) invalid();
        if (search ? typeof input.query !== 'string' || !input.query.trim() || input.query.length > 500 : typeof input.productId !== 'string' || !/^gid:\/\/shopify\/(?:p|Product|ProductVariant)\/[A-Za-z0-9_-]{1,150}$/.test(input.productId)) invalid();
        const context = catalogContext({ address_country: input.country, language: input.language, currency: input.currency });
        if ((input.country !== undefined && !context.address_country) || (input.language !== undefined && !context.language) || (input.currency !== undefined && !context.currency)) invalid();
        for (const key of ['minPrice', 'maxPrice']) if (input[key] !== undefined && (typeof input[key] !== 'number' || !Number.isSafeInteger(input[key]) || input[key] < 0 || !context.currency)) invalid();
        if (typeof input.minPrice === 'number' && typeof input.maxPrice === 'number' && input.minPrice > input.maxPrice) invalid();
        return input;
      },
      async execute(input, context) {
        const buyer = catalogContext({ address_country: input.country, language: input.language, currency: input.currency });
        const price: PriceFilter = { ...(input.minPrice !== undefined ? { min: Number(input.minPrice) } : {}), ...(input.maxPrice !== undefined ? { max: Number(input.maxPrice) } : {}) };
        const payload = await catalogRequest(search ? 'search_catalog' : 'get_product', { context: buyer,
          ...(search ? { query: input.query, pagination: { limit: 6 }, filters: { available: true,
            ...(buyer.address_country ? { ships_to: { country: buyer.address_country } } : {}), ...(Object.keys(price).length ? { price } : {}) } } : { id: input.productId }),
        }, context.signal, profileURL);
        const normalized = catalogProducts(payload);
        const products = withinBudget(normalized, buyer, price).filter(p => !search || p.available !== false);
        const messages = Array.isArray(payload.messages) ? payload.messages.slice(0, 8) : [];
        if (products.length < normalized.length) messages.push({ code: 'filtered_results', message: 'Some returned products were unavailable, outside the budget, or priced in a different currency and were omitted. Do not claim those products match the request.' });
        return { ok: true as const, data: { kind: 'catalog_result', schemaVersion: 1, products, context: buyer, ...(Object.keys(price).length ? { priceFilter: price } : {}),
          messages, fetchedAt: new Date().toISOString() } };
      },
    };
  }));
}
