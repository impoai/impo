import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeAnswerText } from '../src/rebyte/citations.js';

const O = '\uE200', C = '\uE201', S = '\uE202';
const answer = `Rain is possible. ${O}cite${S}https://polymarket.com/event/shanghai${S}https://www.meteoprog.com/weather/Szanghaj/month/september/${C}\n\nForecasts can change.`;

test('web citations become Markdown source links without private-use markers', () => {
  assert.equal(normalizeAnswerText(answer, { final: true }),
    'Rain is possible. ([polymarket.com](https://polymarket.com/event/shanghai), [meteoprog.com](https://www.meteoprog.com/weather/Szanghaj/month/september/))\n\nForecasts can change.');
});

test('streaming output is append-only across every prefix', () => {
  let previous = '';
  for (let length = 0; length <= answer.length; length++) {
    const next = normalizeAnswerText(answer.slice(0, length), { final: false });
    assert.ok(next.startsWith(previous), `prefix ${length}`);
    assert.doesNotMatch(next, /[\uE200-\uE2FF]/);
    previous = next;
  }
  assert.ok(normalizeAnswerText(answer, { final: true }).startsWith(previous));
});

test('non-URL sources, unsafe links and other marker kinds keep only readable text', () => {
  assert.equal(normalizeAnswerText(`Hi.${O}cite${S}turn0search0${S}javascript:alert(1)${C}`, { final: true }), 'Hi.');
  assert.equal(normalizeAnswerText(`In ${O}entity${S}["city","Shanghai",""]${C} today`, { final: true }), 'In Shanghai today');
  assert.equal(normalizeAnswerText(`Link ${O}cite${S}https://a.example/x (1)${C}`, { final: true }), 'Link ([a.example](https://a.example/x%20%281%29))');
  assert.equal(normalizeAnswerText(`stray${C}${S} text`, { final: true }), 'stray text');
});

test('an unfinished marker is withheld while streaming and closed when final', () => {
  const open = `Sunny. ${O}cite${S}https://weather.example/today`;
  assert.equal(normalizeAnswerText(open, { final: false }), 'Sunny. ');
  assert.equal(normalizeAnswerText(open, { final: true }), 'Sunny. ([weather.example](https://weather.example/today))');
});
