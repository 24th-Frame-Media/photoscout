import { configureDensity } from '@photoscout/density/host';
import { initializeStore } from '@photoscout/density/store';
import { db, getKv, getSettings, setKv } from './db.js';
import { sunForDay } from './photo.js';
import { publicFetch, readCappedText } from './nethost.js';
import { USER_AGENT, USER_AGENT_METADATA, BROWSER_HEADERS } from './useragent.js';

configureDensity({ db, getKv, getSettings, setKv, sunForDay, publicFetch, readCappedText,
  userAgent: USER_AGENT, userAgentMetadata: USER_AGENT_METADATA, browserHeaders: BROWSER_HEADERS });
initializeStore();
