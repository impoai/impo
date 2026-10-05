import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogContext, catalogProducts, productSelections, readCatalog } from '../src/commerce/catalog.js';
import type { AgentItem } from '../src/rebyte/gateway.js';
import { clientContext } from '../src/tools/device-tools.js';

const id = 'gid://shopify/p/example';
const product = { id, title: 'Commuter bag', options: [{ name: 'Color', values: [{ label: 'Black' }] }],
  variants: [{ id: 'gid://shopify/ProductVariant/123', url: 'https://example.com/bag?variant=123', seller: { name: 'Example' },
    price: { amount: 8900, currency: 'USD' }, availability: { available: true }, media: [{ type: 'image', url: 'https://cdn.shopify.com/bag.jpg' }] }] };
const call = (overrides = {}): AgentItem => ({ type: 'mcp_call', id: 'call-one', turn_id: 'turn-one', server_label: 'shopify_catalog', name: 'search_catalog', status: 'completed', error: null,
  arguments: { meta: {}, catalog: { query: 'bags', context: { address_country: 'US', language: 'en', currency: 'USD' } } },
  output: { structuredContent: { products: [product] } }, ...overrides }) as AgentItem;

test('catalog projection trusts only completed catalog calls in the requested turn and saves references only', () => {
  const parts = productSelections([call(), call({ server_label: 'other' }), call({ turn_id: 'other' }), call({ status: 'failed' }), call({ name: 'complete_checkout' }), call({ error: { message: 'fail' } })], 'turn-one');
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0].data.productIds, [id]);
  assert.equal(parts[0].data.context.address_country, 'US');
  assert.doesNotMatch(JSON.stringify(parts), /8900|bag.jpg|example.com/);
  assert.equal(productSelections([call({ output: { isError: true, structuredContent: { products: [product] } } })], 'turn-one').length, 0);
  assert.equal(productSelections([call({ output: 'malformed' })], 'turn-one').length, 0);

});

test('catalog prices use ISO currency minor units and product links stay merchant-authored', () => {
  for (const [currency, amount, expected] of [['USD', 8900, '89.00'], ['JPY', 12500, '12,500'], ['KWD', 12500, '12.500']] as const) {
    const p = structuredClone(product); p.variants[0].price = { currency, amount };
    const result = catalogProducts({ products: [p] })[0];
    assert.ok(result.price?.formatted.includes(expected));
    assert.equal(result.url, 'https://example.com/bag?variant=123');
  }
  const invalid = structuredClone(product); invalid.variants[0].url = 'javascript:alert(1)';
  assert.deepEqual(catalogProducts({ products: [invalid] }), []);
  const image = structuredClone(product); image.variants[0].media[0].url = 'https://untrusted.test/image';
  assert.equal(catalogProducts({ products: [image] })[0].imageURL, undefined);
});

test('catalog context validates country, language and currency without inventing defaults', () => {
  assert.deepEqual(catalogContext({ address_country: 'US', language: 'zh-Hans', currency: 'JPY', postal_code: 'private' }), { address_country: 'US', language: 'zh-Hans', currency: 'JPY' });
  assert.deepEqual(catalogContext({ address_country: 'USA', language: 'invalid language', currency: 'usd' }), {});
  const input = { timeZone: 'Asia/Shanghai', currentDate: '2026-10-04T00:00:00Z', country: 'US', language: 'zh-Hans', currency: 'USD' };
  assert.deepEqual(clientContext(input), input);
  assert.throws(() => clientContext({ ...input, country: 'USA' }));
});

test('fresh product reads preserve context, reject products outside the selection and surface outages', async t => {
  let requests = 0;
  const selection = productSelections([call()], 'turn-one')[0].data;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests++;
    const body = JSON.parse(String(init.body));
    assert.equal(body.params.name, 'lookup_catalog');
    assert.deepEqual(body.params.arguments.catalog.context, selection.context);
    return Response.json({ result: { structuredContent: { products: [product] } } });
  });
  await assert.rejects(readCatalog(selection, 'gid://shopify/p/not-owned'), { status: 404 });
  assert.equal(requests, 0);
  assert.equal((await readCatalog(selection)).products.length, 1);
  await readCatalog(selection);
  assert.equal(requests, 2, 'A previous result must not satisfy a new read');
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'unavailable' }, { status: 503 }));
  await assert.rejects(readCatalog(selection), { code: 'catalog_unavailable' });
});

test('function results retain trusted references and price bounds across refresh', async t => {
  const { catalogToolRegistry } = await import('../src/tools/catalog-tools.js');
  const tool = catalogToolRegistry().get('impo_search_products', 1);
  assert.throws(() => tool.validate({ query: 'bag', maxPrice: 100 }));
  assert.throws(() => tool.validate({ query: 'bag', currency: 'USD', minPrice: 101, maxPrice: 100 }));
  const variants = [['matching', 'JPY', 10000], ['expensive', 'JPY', 29000], ['currency', 'USD', 8900]] as const;
  const products = variants.map(([key, currency, amount]) => {
    const p = structuredClone(product); p.id = `gid://shopify/p/${key}`; p.variants[0].price = { currency, amount }; return p;
  });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ result: { structuredContent: { products } } }));
  const result = await tool.execute(tool.validate({ query: 'bag', country: 'JP', language: 'ja', currency: 'JPY', maxPrice: 20000 }), { userId: 'test', invocationId: 'test', signal: AbortSignal.timeout(1000) });
  assert.ok(result.ok);
  assert.equal((result.data.products as unknown[]).length, 1);
  const items = [
    { id: 'call', type: 'function_call', turn_id: 'turn', call_id: 'catalog', name: tool.name, arguments: { query: 'bag' } },
    { id: 'output', type: 'function_call_output', turn_id: 'turn', call_id: 'catalog', status: 'completed', output: JSON.stringify(result.data) },
  ] as AgentItem[];
  const selection = productSelections(items, 'turn')[0].data;
  assert.deepEqual(selection.priceFilter, { max: 20000 });
  assert.deepEqual(selection.productIds, ['gid://shopify/p/matching']);
  assert.deepEqual((await readCatalog(selection)).products.map(p => p.id), selection.productIds);
  products[0].variants[0].price.amount = 21000;
  assert.deepEqual((await readCatalog(selection)).products, [], 'A refreshed price over budget must not be presented as a match');
  assert.deepEqual(productSelections([items[1]], 'turn'), [], 'An orphan output is not trusted');
  assert.deepEqual(productSelections([{ ...items[0], name: 'other_tool' }, items[1]] as AgentItem[], 'turn'), []);
});
