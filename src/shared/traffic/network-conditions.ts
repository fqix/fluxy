export const networkPresets = {
    threeG: { name: '3G', delay: 400, downloadKbps: 780, uploadKbps: 330 },
    edge: { name: 'EDGE', delay: 850, downloadKbps: 240, uploadKbps: 200 },
    lte: { name: 'LTE', delay: 50, downloadKbps: 50000, uploadKbps: 10000 },
    veryBadNetwork: { name: 'Very Bad Network', delay: 2000, downloadKbps: 1000, uploadKbps: 1000 },
    wifi: { name: 'WiFi', delay: 2, downloadKbps: 40000, uploadKbps: 30000 },
    custom: { name: 'Custom', delay: 0, downloadKbps: 0, uploadKbps: 0 }
} as const
export type NetworkPreset = keyof typeof networkPresets
