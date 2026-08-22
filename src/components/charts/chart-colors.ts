// Adapted from Tremor chartColors [v0.1.0] - github.com/tremorlabs/tremor (Apache-2.0)
//
// Upstream ships a fixed set of Tailwind palette colours (bg-blue-500,
// stroke-emerald-500, ...). This app names its series after what they measure
// and paints them from the theme tokens in src/styles.css, so the map is
// rewritten while the mechanism - a class per SVG paint channel, resolved by
// `currentColor` inside the gradient - is kept exactly as upstream designed it.

export type ColorUtility = 'bg' | 'stroke' | 'fill' | 'text'

export const chartColors = {
  primary: {
    bg: 'bg-primary',
    stroke: 'stroke-primary',
    fill: 'fill-primary',
    text: 'text-primary'
  },
  cpu: {
    bg: 'bg-metric-cpu',
    stroke: 'stroke-metric-cpu',
    fill: 'fill-metric-cpu',
    text: 'text-metric-cpu'
  },
  mem: {
    bg: 'bg-metric-mem',
    stroke: 'stroke-metric-mem',
    fill: 'fill-metric-mem',
    text: 'text-metric-mem'
  },
  gpu: {
    bg: 'bg-metric-gpu',
    stroke: 'stroke-metric-gpu',
    fill: 'fill-metric-gpu',
    text: 'text-metric-gpu'
  },
  docker: {
    bg: 'bg-metric-docker',
    stroke: 'stroke-metric-docker',
    fill: 'fill-metric-docker',
    text: 'text-metric-docker'
  },
  net: {
    bg: 'bg-metric-net',
    stroke: 'stroke-metric-net',
    fill: 'fill-metric-net',
    text: 'text-metric-net'
  },
  disk: {
    bg: 'bg-metric-disk',
    stroke: 'stroke-metric-disk',
    fill: 'fill-metric-disk',
    text: 'text-metric-disk'
  },
  // Traffic direction stays deliberately distinct from every other series
  // colour, so a glance at any chart tells download from upload.
  download: {
    bg: 'bg-metric-download',
    stroke: 'stroke-metric-download',
    fill: 'fill-metric-download',
    text: 'text-metric-download'
  },
  upload: {
    bg: 'bg-metric-upload',
    stroke: 'stroke-metric-upload',
    fill: 'fill-metric-upload',
    text: 'text-metric-upload'
  },
  success: {
    bg: 'bg-success',
    stroke: 'stroke-success',
    fill: 'fill-success',
    text: 'text-success'
  },
  warning: {
    bg: 'bg-warning',
    stroke: 'stroke-warning',
    fill: 'fill-warning',
    text: 'text-warning'
  },
  destructive: {
    bg: 'bg-destructive',
    stroke: 'stroke-destructive',
    fill: 'fill-destructive',
    text: 'text-destructive'
  },
  // Unknown / unset health — muted-foreground, not muted (that token is a
  // surface). Same grey the status wall uses for cards that have not been swept.
  muted: {
    bg: 'bg-muted-foreground',
    stroke: 'stroke-muted-foreground',
    fill: 'fill-muted-foreground',
    text: 'text-muted-foreground'
  }
} as const satisfies {
  [color: string]: { [key in ColorUtility]: string }
}

export type ChartColor = keyof typeof chartColors

/** Fallback order for series a spec did not name a colour for. */
export const AvailableChartColors: ChartColor[] = [
  'primary',
  'cpu',
  'mem',
  'net',
  'disk',
  'warning',
  'success',
  'gpu'
]

export const constructCategoryColors = (
  categories: string[],
  colors: ChartColor[]
): Map<string, ChartColor> => {
  const categoryColors = new Map<string, ChartColor>()
  categories.forEach((category, index) => {
    categoryColors.set(category, colors[index % colors.length])
  })
  return categoryColors
}

export const getColorClassName = (color: ChartColor, type: ColorUtility): string => {
  return chartColors[color]?.[type] ?? chartColors.primary[type]
}
