import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPlaneDetails } from '../src/map/planes.js';

test('formatPlaneDetails: formats aircraft, operator, route and registration', () => {
  const full = {
    manufacturer: 'Airbus',
    type: 'A380-842',
    airline: 'Qantas',
    owner: 'Qantas',
    origin: 'SYD',
    destination: 'DFW',
    registration: 'VH-OQA',
  };
  assert.equal(formatPlaneDetails(full), 'Airbus A380-842 · Qantas · SYD → DFW · VH-OQA');

  // Type already includes manufacturer
  const prefixed = {
    manufacturer: 'Airbus',
    type: 'Airbus A320-200',
    airline: 'Jetstar',
    owner: null,
    origin: 'MEL',
    destination: 'SYD',
    registration: 'VH-VGF',
  };
  assert.equal(formatPlaneDetails(prefixed), 'Airbus A320-200 · Jetstar · MEL → SYD · VH-VGF');

  // Partial info (no route, owner fallback)
  const privatePlane = {
    manufacturer: 'Cessna',
    type: '172S',
    airline: null,
    owner: 'Private Owner',
    origin: null,
    destination: null,
    registration: 'VH-ABC',
  };
  assert.equal(formatPlaneDetails(privatePlane), 'Cessna 172S · Private Owner · VH-ABC');

  // All nulls
  const empty = {
    manufacturer: null,
    type: null,
    airline: null,
    owner: null,
    origin: null,
    destination: null,
    registration: null,
  };
  assert.equal(formatPlaneDetails(empty), null);
});
