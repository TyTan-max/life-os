// A small, self-contained world map for the Bucket List: stylised continent outlines (drawn by
// hand from a few dozen points each — recognisable, not survey-grade) and a lookup that turns a
// place name ("Peru", "Tokyo, Japan") into a spot on it. No map tiles, no network.

export const MAP_W = 1000;
export const MAP_H = 394;
const LAT_TOP = 84;
const LAT_BOTTOM = -58;

/** Longitude/latitude → x/y on the map (plain equirectangular). */
export function project(lon: number, lat: number): [number, number] {
  const x = ((lon + 180) / 360) * MAP_W;
  const y = ((LAT_TOP - lat) / (LAT_TOP - LAT_BOTTOM)) * MAP_H;
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
}

type Poly = [number, number][];

const LAND: Poly[] = [
  // North America
  [[-168, 66], [-156, 71], [-128, 70], [-110, 68], [-95, 72], [-82, 70], [-78, 62], [-64, 60], [-56, 52], [-66, 45], [-70, 42], [-76, 35], [-81, 31], [-80, 25], [-84, 30], [-90, 29], [-97, 26], [-97, 20], [-92, 18], [-88, 21], [-87, 16], [-83, 10], [-78, 8], [-82, 8], [-86, 12], [-94, 16], [-105, 20], [-110, 24], [-114, 30], [-117, 33], [-124, 40], [-124, 48], [-130, 55], [-140, 60], [-152, 58], [-160, 56], [-166, 60]],
  // Greenland
  [[-52, 60], [-44, 60], [-22, 70], [-20, 78], [-35, 83], [-58, 82], [-70, 77], [-56, 70]],
  // South America
  [[-78, 8], [-72, 12], [-62, 10], [-52, 5], [-50, 0], [-35, -6], [-39, -14], [-41, -22], [-48, -26], [-54, -34], [-58, -38], [-65, -42], [-66, -48], [-69, -53], [-74, -52], [-73, -42], [-72, -30], [-70, -18], [-76, -14], [-81, -5], [-80, 1]],
  // Europe
  [[-9, 37], [-9, 43], [-2, 44], [-5, 48], [2, 51], [8, 54], [8, 57], [5, 58], [6, 62], [14, 68], [25, 71], [31, 70], [41, 67], [44, 66], [60, 69], [60, 55], [50, 46], [40, 47], [37, 45], [28, 41], [24, 38], [22, 37], [20, 40], [14, 45], [12, 44], [18, 40], [16, 38], [12, 42], [8, 44], [3, 43], [0, 39], [-5, 36]],
  // Great Britain and Ireland
  [[-5, 50], [1, 51], [0, 53], [-2, 56], [-5, 58], [-6, 55], [-3, 53], [-5, 52]],
  [[-10, 52], [-6, 52], [-6, 55], [-10, 54]],
  // Iceland
  [[-24, 65], [-14, 64], [-14, 66], [-22, 66.5]],
  // Africa
  [[-17, 21], [-13, 28], [-6, 35], [10, 37], [11, 33], [20, 31], [32, 31], [35, 28], [37, 22], [43, 12], [51, 12], [48, 5], [42, -2], [40, -10], [40, -16], [35, -24], [32, -29], [27, -34], [20, -35], [18, -30], [15, -23], [12, -16], [13, -8], [9, -1], [9, 4], [5, 6], [-4, 5], [-8, 4], [-13, 8], [-17, 13]],
  // Madagascar
  [[44, -25], [47, -25], [50, -16], [49, -12], [44, -17]],
  // Asia
  [[60, 55], [60, 69], [70, 73], [90, 76], [105, 78], [115, 74], [140, 73], [160, 70], [180, 68], [180, 65], [172, 61], [163, 58], [160, 52], [156, 51], [155, 58], [142, 59], [140, 52], [135, 45], [130, 42], [128, 38], [126, 34], [122, 38], [118, 38], [122, 31], [120, 26], [114, 22], [108, 21], [109, 13], [105, 9], [100, 13], [99, 8], [103, 2], [101, 4], [98, 9], [98, 16], [94, 17], [91, 22], [87, 21], [80, 15], [80, 9], [77, 8], [73, 16], [72, 21], [67, 25], [57, 25], [56, 27], [51, 28], [48, 30], [51, 24], [56, 24], [59, 22], [55, 17], [45, 13], [43, 13], [39, 21], [35, 28], [36, 36], [28, 37], [28, 41], [40, 47], [50, 46]],
  // Sri Lanka
  [[80, 9.5], [82, 7.5], [80.5, 6], [79.8, 8]],
  // Japan
  [[130, 31], [135, 34], [140, 36], [142, 40], [141, 45], [145, 44], [141, 42], [139, 38], [134, 36], [131, 34]],
  // Taiwan
  [[120.2, 23], [121.8, 25], [121, 22]],
  // Philippines
  [[120, 18], [122, 14], [126, 7], [122, 8], [120, 13]],
  // Sumatra, Java, Borneo, Sulawesi, New Guinea
  [[95, 5], [104, -5], [106, -6], [100, 0]],
  [[106, -6], [114, -8], [106, -7.6]],
  [[109, 1], [117, 7], [119, 1], [116, -4], [110, -3]],
  [[119.5, 1], [124, 1], [121, -5], [120, -2]],
  [[131, -1], [141, -3], [150, -6], [147, -10], [141, -9], [133, -4]],
  // Australia and Tasmania
  [[114, -22], [122, -17], [129, -15], [131, -12], [136, -12], [136, -16], [141, -13], [142, -11], [146, -19], [153, -25], [153, -32], [150, -37], [146, -39], [140, -38], [135, -35], [131, -31], [124, -33], [116, -35], [114, -31]],
  [[145, -41], [148, -41], [147, -43.5], [145.5, -43]],
  // New Zealand
  [[173, -35], [178, -38], [175, -41], [172.5, -40.5], [174, -37]],
  [[172, -41], [174, -42], [170, -46], [167, -46], [169, -43]],
  // Cuba, Hispaniola
  [[-84, 22], [-75, 20], [-74, 20.5], [-80, 23]],
  [[-74, 19.5], [-69, 18.5], [-70, 20]]
];

/** The land as SVG path data. */
export const LAND_PATH: string = LAND
  .map(poly => poly.map(([lon, lat], i) => `${i ? 'L' : 'M'}${project(lon, lat).join(' ')}`).join(' ') + ' Z')
  .join(' ');

// name → [lon, lat]. Countries by rough centre; a handful of regions, cities and landmarks people
// actually write on a bucket list.
const PLACES: Record<string, [number, number]> = {
  // Americas
  'united states': [-98, 39], usa: [-98, 39], us: [-98, 39], america: [-98, 39], canada: [-106, 56], mexico: [-102, 23],
  alaska: [-150, 64], hawaii: [-157, 21], california: [-119, 37], 'new york': [-74, 40.7], nyc: [-74, 40.7], florida: [-82, 28], texas: [-99, 31],
  'los angeles': [-118.2, 34], 'san francisco': [-122.4, 37.8], 'las vegas': [-115.1, 36.2], chicago: [-87.6, 41.9], miami: [-80.2, 25.8], seattle: [-122.3, 47.6],
  'grand canyon': [-112.1, 36.1], yellowstone: [-110.6, 44.6], yosemite: [-119.5, 37.9], 'new orleans': [-90.1, 30], boston: [-71.1, 42.4], washington: [-77, 38.9],
  vancouver: [-123.1, 49.3], toronto: [-79.4, 43.7], banff: [-115.6, 51.2], montreal: [-73.6, 45.5], cancun: [-86.8, 21.2], 'mexico city': [-99.1, 19.4],
  guatemala: [-90.3, 15.5], belize: [-88.7, 17.2], honduras: [-86.6, 14.8], 'el salvador': [-88.9, 13.7], nicaragua: [-85, 12.9], 'costa rica': [-84, 10], panama: [-80, 8.5],
  cuba: [-79, 21.5], jamaica: [-77.3, 18.1], bahamas: [-77.4, 25], 'dominican republic': [-70.2, 18.9], 'puerto rico': [-66.5, 18.2], haiti: [-72.3, 19],
  colombia: [-73, 4], venezuela: [-66, 7], ecuador: [-78.5, -1.5], galapagos: [-90.5, -0.7], peru: [-75, -10], 'machu picchu': [-72.5, -13.2], bolivia: [-65, -17],
  brazil: [-52, -10], rio: [-43.2, -22.9], 'rio de janeiro': [-43.2, -22.9], amazon: [-62, -4], chile: [-71, -33], patagonia: [-71, -47], argentina: [-64, -35],
  'buenos aires': [-58.4, -34.6], uruguay: [-56, -33], paraguay: [-58, -23],
  // Europe
  iceland: [-19, 65], ireland: [-8, 53], dublin: [-6.3, 53.3], 'united kingdom': [-2, 54], uk: [-2, 54], england: [-1.5, 52.5], london: [-0.1, 51.5],
  scotland: [-4, 57], edinburgh: [-3.2, 55.9], wales: [-3.7, 52.3], portugal: [-8, 39.5], lisbon: [-9.1, 38.7], spain: [-4, 40], madrid: [-3.7, 40.4],
  barcelona: [2.2, 41.4], france: [2.5, 46.5], paris: [2.35, 48.86], belgium: [4.5, 50.6], netherlands: [5.3, 52.2], amsterdam: [4.9, 52.4], germany: [10.5, 51],
  berlin: [13.4, 52.5], munich: [11.6, 48.1], switzerland: [8.2, 46.8], alps: [10, 46.5], austria: [14.5, 47.5], vienna: [16.4, 48.2], italy: [12.5, 42.8],
  rome: [12.5, 41.9], venice: [12.3, 45.4], florence: [11.3, 43.8], milan: [9.2, 45.5], 'amalfi coast': [14.6, 40.6], sicily: [14, 37.5], denmark: [9.5, 56],
  copenhagen: [12.6, 55.7], norway: [9, 61], oslo: [10.7, 59.9], sweden: [15, 62], stockholm: [18.1, 59.3], finland: [26, 63], lapland: [25, 68],
  poland: [19.5, 52], 'czech republic': [15.5, 49.8], czechia: [15.5, 49.8], prague: [14.4, 50.1], hungary: [19.5, 47], budapest: [19, 47.5], croatia: [16, 45.2],
  dubrovnik: [18.1, 42.6], greece: [22, 39.5], athens: [23.7, 38], santorini: [25.4, 36.4], turkey: [35, 39], istanbul: [29, 41], cappadocia: [34.8, 38.6],
  romania: [25, 46], bulgaria: [25.5, 42.7], serbia: [21, 44], ukraine: [31.5, 49], russia: [90, 61], moscow: [37.6, 55.8],
  // Africa and the Middle East
  morocco: [-6, 32], marrakech: [-8, 31.6], egypt: [30, 27], cairo: [31.2, 30], pyramids: [31.1, 29.98], tunisia: [9.5, 34], algeria: [3, 28],
  nigeria: [8, 9.5], ghana: [-1.2, 8], senegal: [-14.5, 14.5], ethiopia: [39.5, 9], kenya: [38, 0.5], tanzania: [35, -6.5], kilimanjaro: [37.35, -3.07],
  serengeti: [34.8, -2.3], zanzibar: [39.3, -6.1], uganda: [32.3, 1.3], rwanda: [29.9, -2], madagascar: [47, -19], mozambique: [35.5, -18],
  zimbabwe: [29.8, -19], 'victoria falls': [25.85, -17.92], botswana: [24, -22], namibia: [17, -22], 'south africa': [24, -29.5], 'cape town': [18.4, -33.9],
  israel: [35, 31.5], jordan: [36.5, 31], petra: [35.44, 30.33], 'saudi arabia': [45, 24], 'united arab emirates': [54, 24], uae: [54, 24], dubai: [55.3, 25.2],
  qatar: [51.2, 25.3], iran: [53.5, 32.5],
  // Asia
  india: [79, 22], 'taj mahal': [78.04, 27.17], delhi: [77.2, 28.6], mumbai: [72.9, 19.1], goa: [74, 15.4], nepal: [84, 28.2], everest: [86.9, 28],
  'sri lanka': [80.8, 7.8], maldives: [73.5, 3.2], pakistan: [69.5, 30], bangladesh: [90.3, 23.8], bhutan: [90.4, 27.5], china: [104, 35],
  beijing: [116.4, 39.9], shanghai: [121.5, 31.2], 'great wall': [116.6, 40.4], 'hong kong': [114.2, 22.3], taiwan: [121, 23.7], mongolia: [103, 46.8],
  japan: [138, 36.5], tokyo: [139.7, 35.7], kyoto: [135.8, 35], osaka: [135.5, 34.7], 'mount fuji': [138.7, 35.4], 'south korea': [127.8, 36.3], korea: [127.8, 36.3],
  seoul: [127, 37.6], vietnam: [106, 16], hanoi: [105.8, 21], 'ha long bay': [107.1, 20.9], 'ho chi minh': [106.7, 10.8], cambodia: [105, 12.5],
  'angkor wat': [103.87, 13.41], laos: [103, 18.5], thailand: [101, 15], bangkok: [100.5, 13.8], phuket: [98.4, 7.9], 'chiang mai': [99, 18.8],
  myanmar: [96, 21], malaysia: [102, 4], singapore: [103.8, 1.35], indonesia: [117, -2], bali: [115.2, -8.4], philippines: [122, 12.5],
  // Oceania
  australia: [134, -25], sydney: [151.2, -33.9], melbourne: [145, -37.8], 'great barrier reef': [146, -18], uluru: [131, -25.3], tasmania: [146.5, -42],
  'new zealand': [172.5, -41.5], queenstown: [168.7, -45], fiji: [178, -17.8], tahiti: [-149.4, -17.7], 'bora bora': [-151.7, -16.5], 'papua new guinea': [144, -6],
  antarctica: [0, -57]
};

const NAMES = Object.keys(PLACES).sort((a, b) => b.length - a.length);

/**
 * Finds a place name inside free text and returns where it is. The most specific match wins
 * ("Kyoto, Japan" → Kyoto). Whole words only, so "us" doesn't match inside "Austria".
 */
export function locate(location?: string, title?: string): { lon: number; lat: number; name: string } | null {
  for (const text of [location, title]) {
    const hay = ` ${(text ?? '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ')} `;
    if (hay.trim().length < 2) continue;
    for (const name of NAMES) {
      // Two-letter codes ("us", "uk") only count from the location field, never from a title.
      if (name.length <= 3 && text !== location) continue;
      if (hay.includes(` ${name} `)) return { lon: PLACES[name][0], lat: PLACES[name][1], name };
    }
  }
  return null;
}
