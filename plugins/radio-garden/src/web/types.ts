/** What the radio-garden server routes answer with. Defined here so the web bundle imports nothing from the app. */

export interface RadioPlace {
  id: string;
  title: string;
  country: string;
  lng: number;
  lat: number;
  stationCount: number;
}

export interface RadioStation {
  id: string;
  title: string;
  placeId: string;
  streamDomain?: string;
  listenUrl: string;
}

export interface RadioPlacesResponse {
  places: RadioPlace[];
}

export interface RadioStationsResponse {
  placeId: string;
  title?: string;
  country?: string;
  stations: RadioStation[];
}
