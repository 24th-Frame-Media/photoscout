import { createContext, useContext } from 'react';
import type { Map as MlMap } from 'maplibre-gl';
import type { Fix } from './camera.js';

/**
 * What the Drive screen shares with anything drawn inside it. Pass components
 * as children of <Drive> and they can read the map (null until its style has
 * loaded) to add their own markers and layers, e.g. the other cars in a convoy,
 * and the driver's latest fix.
 */
export interface DriveMapApi {
  map: MlMap | null;
  fix: Fix | null;
}

export const DriveMapContext = createContext<DriveMapApi>({ map: null, fix: null });
export const useDriveMap = (): DriveMapApi => useContext(DriveMapContext);
