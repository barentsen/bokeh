import {SpatialIndex} from "core/util/spatial"
import {Glyph, GlyphView, GlyphData} from "./glyph"
import {generic_area_legend} from "./utils"
import {min, max, copy, find_last_index} from "core/util/array"
import {sum} from "core/util/arrayable"
import {isStrictNaN} from "core/util/types"
import {Arrayable, Rect} from "core/types"
import {PointGeometry, RectGeometry} from "core/geometry"
import {Context2d} from "core/util/canvas"
import {LineVector, FillVector, HatchVector} from "core/property_mixins"
import {Line, Fill, Hatch} from "core/visuals"
import * as hittest from "core/hittest"
import * as p from "core/properties"
import {Selection} from "../selections/selection"
import {unreachable} from "core/util/assert"

export interface PatchesData extends GlyphData {
  _xs: Arrayable<Arrayable<number>>
  _ys: Arrayable<Arrayable<number>>

  sxs: Arrayable<Arrayable<number>>
  sys: Arrayable<Arrayable<number>>

  sxss: number[][][]
  syss: number[][][]
}

export interface PatchesView extends PatchesData {}

export class PatchesView extends GlyphView {
  model: Patches
  visuals: Patches.Visuals

  private _build_discontinuous_object(nanned_qs: number[][]): number[][][] {
    // _s is this.xs, this.ys, this.sxs, this.sys
    // an object of n 1-d arrays in either data or screen units
    //
    // Each 1-d array gets broken to an array of arrays split
    // on any NaNs
    //
    // So:
    // { 0: [x11, x12],
    //   1: [x21, x22, x23],
    //   2: [x31, NaN, x32]
    // }
    // becomes
    // { 0: [[x11, x12]],
    //   1: [[x21, x22, x23]],
    //   2: [[x31],[x32]]
    // }
    const ds: number[][][] = []
    for (let i = 0, end = nanned_qs.length; i < end; i++) {
      ds[i] = []
      let qs = copy(nanned_qs[i])
      while (qs.length > 0) {
        const nan_index = find_last_index(qs, (q) => isStrictNaN(q))

        let qs_part
        if (nan_index >= 0)
          qs_part = qs.splice(nan_index)
        else {
          qs_part = qs
          qs = []
        }

        const denanned = qs_part.filter((q) => !isStrictNaN(q))
        ds[i].push(denanned)
      }
    }
    return ds
  }

  protected _index_data(): SpatialIndex {
    const xss = this._build_discontinuous_object(this._xs as any) // XXX
    const yss = this._build_discontinuous_object(this._ys as any) // XXX

    const points = []
    for (let i = 0, end = this._xs.length; i < end; i++) {
      for (let j = 0, endj = xss[i].length; j < endj; j++) {
        const xs = xss[i][j]
        const ys = yss[i][j]

        if (xs.length == 0)
          continue

        points.push({x0: min(xs), y0: min(ys), x1: max(xs), y1: max(ys), i})
      }
    }

    return new SpatialIndex(points)
  }

  protected _mask_data(): number[] {
    const xr = this.renderer.plot_view.frame.x_ranges.default
    const [x0, x1] = [xr.min, xr.max]

    const yr = this.renderer.plot_view.frame.y_ranges.default
    const [y0, y1] = [yr.min, yr.max]

    const indices = this.index.indices({x0, x1, y0, y1})

    // TODO (bev) this should be under test
    return indices.sort((a, b) => a - b)
  }

  protected _inner_loop(ctx: Context2d, sx: Arrayable<number>, sy: Arrayable<number>, func: (this: Context2d) => void): void {
    for (let j = 0, end = sx.length; j < end; j++) {
      if (j == 0) {
        ctx.beginPath()
        ctx.moveTo(sx[j], sy[j])
        continue
      } else if (isNaN(sx[j] + sy[j])) {
        ctx.closePath()
        func.apply(ctx)
        ctx.beginPath()
        continue
      } else
        ctx.lineTo(sx[j], sy[j])
    }
    ctx.closePath()
    func.call(ctx)
  }

  protected _render(ctx: Context2d, indices: number[], {sxs, sys}: PatchesData): void {
    // this.sxss and this.syss are used by _hit_point and sxc, syc
    // This is the earliest we can build them, and only build them once
    this.sxss = this._build_discontinuous_object(sxs as any) // XXX
    this.syss = this._build_discontinuous_object(sys as any) // XXX

    for (const i of indices) {
      const [sx, sy] = [sxs[i], sys[i]]

      if (this.visuals.fill.doit) {
        this.visuals.fill.set_vectorize(ctx, i)
        this._inner_loop(ctx, sx, sy, ctx.fill)
      }

      this.visuals.hatch.doit2(ctx, i, () => this._inner_loop(ctx, sx, sy, ctx.fill), () => this.renderer.request_render())

      if (this.visuals.line.doit) {
        this.visuals.line.set_vectorize(ctx, i)
        this._inner_loop(ctx, sx, sy, ctx.stroke)
      }
    }
  }

  protected _hit_rect(geometry: RectGeometry): Selection {
    const {sx0, sx1, sy0, sy1} = geometry
    const xs = [sx0, sx1, sx1, sx0]
    const ys = [sy0, sy0, sy1, sy1]
    const [x0, x1] = this.renderer.xscale.r_invert(sx0, sx1)
    const [y0, y1] = this.renderer.yscale.r_invert(sy0, sy1)
    const candidates = this.index.indices({x0, x1, y0, y1})
    const hits = []
    for (let i = 0, end = candidates.length; i < end; i++) {
      const idx = candidates[i]
      const sxss = this.sxs[idx]
      const syss = this.sys[idx]
      let hit = true
      for (let j = 0, endj = sxss.length; j < endj; j++) {
        const sx = sxss[j]
        const sy = syss[j]
        if (!hittest.point_in_poly(sx, sy, xs, ys)) {
          hit = false
          break
        }
      }
      if (hit)
        hits.push(idx)
    }
    const result = hittest.create_empty_hit_test_result()
    result.indices = hits
    return result
  }

  protected _hit_point(geometry: PointGeometry): Selection {
    const {sx, sy} = geometry

    const x = this.renderer.xscale.invert(sx)
    const y = this.renderer.yscale.invert(sy)

    const candidates = this.index.indices({x0: x, y0: y, x1: x, y1: y})

    const hits = []
    for (let i = 0, end = candidates.length; i < end; i++) {
      const idx = candidates[i]
      const sxs = this.sxss[idx]
      const sys = this.syss[idx]
      for (let j = 0, endj = sxs.length; j < endj; j++) {
        if (hittest.point_in_poly(sx, sy, sxs[j], sys[j])) {
          hits.push(idx)
        }
      }
    }

    const result = hittest.create_empty_hit_test_result()
    result.indices = hits
    return result
  }

  private _get_snap_coord(array: Arrayable<number>): number {
    return sum(array) / array.length
  }

  scenterx(i: number, sx: number, sy: number): number {
    if (this.sxss[i].length == 1) {
      // We don't have discontinuous objects so we're ok
      return this._get_snap_coord(this.sxs[i])
    } else {
      // We have discontinuous objects, so we need to find which
      // one we're in, we can use point_in_poly again
      const sxs = this.sxss[i]
      const sys = this.syss[i]
      for (let j = 0, end = sxs.length; j < end; j++) {
        if (hittest.point_in_poly(sx, sy, sxs[j], sys[j]))
          return this._get_snap_coord(sxs[j])
      }
    }

    unreachable()
  }

  scentery(i: number, sx: number, sy: number): number {
    if (this.syss[i].length == 1) {
      // We don't have discontinuous objects so we're ok
      return this._get_snap_coord(this.sys[i])
    } else {
      // We have discontinuous objects, so we need to find which
      // one we're in, we can use point_in_poly again
      const sxs = this.sxss[i]
      const sys = this.syss[i]
      for (let j = 0, end = sxs.length; j < end; j++) {
        if (hittest.point_in_poly(sx, sy, sxs[j], sys[j]))
          return this._get_snap_coord(sys[j])
      }
    }

    unreachable()
  }

  draw_legend_for_index(ctx: Context2d, bbox: Rect, index: number): void {
    generic_area_legend(this.visuals, ctx, bbox, index)
  }
}

export namespace Patches {
  export type Attrs = p.AttrsOf<Props>

  export type Props = Glyph.Props & LineVector & FillVector & HatchVector & {
    xs: p.CoordinateSeqSpec
    ys: p.CoordinateSeqSpec
  }

  export type Visuals = Glyph.Visuals & {line: Line, fill: Fill, hatch: Hatch}
}

export interface Patches extends Patches.Attrs {}

export class Patches extends Glyph {
  properties: Patches.Props

  constructor(attrs?: Partial<Patches.Attrs>) {
    super(attrs)
  }

  static init_Patches(): void {
    this.prototype.default_view = PatchesView

    this.coords([['xs', 'ys']])
    this.mixins(['line', 'fill', 'hatch'])
  }
}
