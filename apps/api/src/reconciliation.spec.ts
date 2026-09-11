import test from 'node:test';
import assert from 'node:assert/strict';
import { unexplained, wasteCostMinor } from './reconciliation';
test('calculates unexplained stock',()=>assert.equal(unexplained({loaded:100,consumed:72,returned:20,spoiled:3,discarded:2}),3));
test('prices waste in integer minor units',()=>assert.equal(wasteCostMinor({loaded:10,consumed:6,returned:1,spoiled:1,discarded:1},750),2250));
test('rejects over-accounting',()=>assert.throws(()=>unexplained({loaded:4,consumed:5,returned:0,spoiled:0,discarded:0})));
