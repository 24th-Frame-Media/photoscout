import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { MapMenus, type Menu } from '../src/components/MapMenus.js';

test('MapMenus renders pills with correct labels, active badges, and vector chevrons', () => {
  let toggled = false;
  let actionTriggered = false;

  const menus: Menu[] = [
    {
      label: 'Live',
      items: [
        { key: 'planes', label: 'Planes', on: true, onSelect: () => { toggled = true; } },
        { key: 'trains', label: 'Trains', on: true, onSelect: () => {} },
        { key: 'radar', label: 'Rain radar', on: false, onSelect: () => {} },
      ],
    },
    {
      label: 'Scout',
      items: [
        { key: 'viewpoints', label: 'Viewpoints', on: false, onSelect: () => {} },
      ],
    },
    {
      label: '+ Add',
      items: [
        { key: 'spot', label: 'Spot', onSelect: () => { actionTriggered = true; } },
      ],
    },
  ];

  const html = renderToString(React.createElement(MapMenus, { menus }));

  // Live menu should have badge count of 2
  assert.ok(html.includes('Live'));
  assert.ok(html.includes('<span class="mapmenu__count">2</span>'));

  // Scout menu has 0 active items, so no badge
  assert.ok(html.includes('Scout'));
  assert.ok(!html.includes('>Scout<span class="mapmenu__count">'));

  // + Add menu has action items, so no badge
  assert.ok(html.includes('+ Add'));

  // All menus should have clean vector chevron SVG instead of raw unicode triangle
  assert.ok(html.includes('mapmenu__chevron'));
  assert.ok(!html.includes('▾'));

  // Verify callbacks work
  menus[0].items[0].onSelect();
  assert.equal(toggled, true);
  menus[2].items[0].onSelect();
  assert.equal(actionTriggered, true);
});
