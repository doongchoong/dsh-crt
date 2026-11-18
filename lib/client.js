// dsh-crt browser half: a "CRT" tab in the conversation view that renders the
// live conversation through WebGL phosphor, scanline and bloom shaders.
//
// Loaded by the dsh module loader with no build step: official client
// packages come through `require`, never bare ESM imports.
//
// Sections
//   1. Themes and shaders   (ported from the author's blog engine, crt-terminal.js)
//   2. CrtScreen            text canvas -> persistence pass -> CRT pass
//   3. toTerminal           Chat snapshot -> terminal entries (isolated so a
//                           future dsh snapshot shape only touches this part)
//   4. CrtView + apply      React view registered in `conversation.view`
//
// MIT License. Copyright (c) 2026 doongchoong.
window.__ModuleLoader__.load({
  id: 'dsh-crt',
  factory: (require) => {
    'use strict'
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    /* ================================================================ *
     * 1. Themes and shaders
     * ================================================================ */

    // col: phosphor colour, k: barrel curvature, tau: persistence (s),
    // vfd: vacuum-fluorescent mode (front-glass mesh, flat glass, no scanlines)
    const THEMES = {
      green: { label: 'GREEN', col: [0.25, 1.0, 0.42], k: 0.20, tau: 0.14, vfd: 0 },
      amber: { label: 'AMBER', col: [1.0, 0.62, 0.10], k: 0.20, tau: 0.11, vfd: 0 },
      vfd: { label: 'VFD', col: [0.32, 0.86, 1.0], k: 0.05, tau: 0.04, vfd: 1 },
    }
    const THEME_ORDER = ['green', 'amber', 'vfd']
    const DEFAULT_THEME = 'green'
    const THEME_KEY = 'dsh-crt:theme'

    const FONT = '"GalmuriMono11","GalmuriMono9","D2Coding",ui-monospace,monospace'
    const GALMURI = 'https://cdn.jsdelivr.net/npm/galmuri@2.40.3/dist/galmuri.css'
    const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
    // Text size steps, smallest first: one text-canvas pixel per N screen
    // pixels of width (larger N = smaller text; the 11px bitmap font stays crisp).
    const SIZE_STEPS = [880, 780, 680, 590, 510]
    const DEFAULT_SIZE = 2
    const SIZE_KEY = 'dsh-crt:size'

    const VS = '#version 300 es\nin vec2 aP;void main(){gl_Position=vec4(aP,0.,1.);}'

    // Phosphor persistence: keep the brighter of the new frame and the decayed previous one.
    const FS_PERSIST = '#version 300 es\nprecision highp float;\n' +
      'uniform sampler2D uCur;uniform sampler2D uPrev;uniform vec2 uRes;uniform float uDecay;out vec4 o;\n' +
      'void main(){vec2 uv=gl_FragCoord.xy/uRes;float c=texture(uCur,uv).r;' +
      'float p=texture(uPrev,uv).r*uDecay-0.004;o=vec4(vec3(max(c,p)),1.);}'

    const FS_CRT = '#version 300 es\nprecision highp float;\n' +
      'uniform sampler2D uTex;uniform vec2 uOut;uniform vec2 uSrc;uniform float uTime;uniform vec3 uCol;uniform float uMotion;uniform float uDpr;uniform float uK;uniform float uVfd;out vec4 o;\n' +
      'float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}\n' +
      // barrel distortion (x1.02 so a sliver of bezel shows at the edges)
      'vec2 warp(vec2 q){vec2 c=q-.5;float k=uK;return .5+c*(1.+k*dot(c,c))*1.02/(1.+k*.25);}\n' +
      'vec3 row(float r,float ux,float ca){float v=(r+.5)/uSrc.y;' +
      'return vec3(texture(uTex,vec2(ux+ca,v)).r,texture(uTex,vec2(ux,v)).r,texture(uTex,vec2(ux-ca,v)).r);}\n' +
      // gaussian beam profile that widens with brightness
      'vec3 beam(vec3 l,float d){vec3 w=mix(vec3(.30),vec3(.56),l);return exp(-d*d/(2.*w*w));}\n' +
      'void main(){\n' +
      ' vec2 q=gl_FragCoord.xy/uOut; vec2 uv=warp(q);\n' +
      ' uv.x+=(hash(vec2(floor(uv.y*uSrc.y),floor(uTime*24.)))-.5)*.0007*uMotion;\n' +
      ' float u=uv.x*uSrc.x; float fu=fract(u); u=floor(u)+.5+clamp((fu-.5)*2.,-.5,.5); float ux=u/uSrc.x;\n' +
      ' vec3 L;\n' +
      ' if(uVfd>.5){\n' +
      // VFD: crisp pixels plus the fine mesh of the front glass
      '  float l=texture(uTex,vec2(ux,(floor(uv.y*uSrc.y)+.5)/uSrc.y)).r;\n' +
      '  vec2 g=fract(gl_FragCoord.xy/(uDpr*3.));\n' +
      '  float mesh=.80+.20*sqrt(min(sin(g.x*3.1416),sin(g.y*3.1416)));\n' +
      '  L=vec3(l*mesh*1.3);\n' +
      ' }else{\n' +
      '  float ca=(uv.x-.5)*1.3/uSrc.x;\n' +
      '  float fy=uv.y*uSrc.y-.5; float r0=floor(fy); float t=fy-r0;\n' +
      '  vec3 a=row(r0,ux,ca), b=row(r0+1.,ux,ca);\n' +
      '  L=(a*beam(a,t)+b*beam(b,1.-t))*1.35;\n' +
      ' }\n' +
      ' float lb=log2(max(uSrc.y/360.,.5));\n' +
      ' float bl=textureLod(uTex,uv,1.5+lb).r*.35+textureLod(uTex,uv,3.+lb).r*.45+textureLod(uTex,uv,4.5+lb).r*.55;\n' +
      ' vec3 col=uCol*L + uCol*bl*(.55+.2*uVfd) + vec3(pow(L.g,3.))*.28;\n' +
      ' col+=uCol*.022;\n' +
      ' float by=1.-fract(uTime*.085)*1.3; col+=uCol*exp(-pow((uv.y-by)*9.,2.))*.035*uMotion;\n' +
      ' col*=1.+uMotion*(.012*sin(uTime*120.)+.025*(hash(vec2(floor(uTime*20.),3.))-.5));\n' +
      ' col+=(hash(gl_FragCoord.xy+fract(uTime*7.)*391.)-.5)*.045*(uMotion*.7+.3);\n' +
      ' float m=mod(gl_FragCoord.x/uDpr,3.);\n' +
      ' col*=mix(vec3(1.),vec3(m<1.?1.:.8,(m>=1.&&m<2.)?1.:.8,m>=2.?1.:.8),.55*(1.-uVfd));\n' +
      ' vec2 vv=uv*(1.-uv.yx); col*=pow(clamp(vv.x*vv.y*16.,0.,1.),.25);\n' +
      ' vec2 e=smoothstep(vec2(0.),vec2(.004),uv)*smoothstep(vec2(0.),vec2(.004),1.-uv);\n' +
      ' vec2 dout=max(max(-uv,uv-1.),0.);\n' +
      ' vec3 bez=vec3(.026,.026,.029)+uCol*textureLod(uTex,clamp(uv,0.,1.),5.+lb).r*.28*exp(-length(dout)*55.);\n' +
      ' o=vec4(clamp(mix(bez,col,e.x*e.y),0.,1.),1.);\n' +
      '}'

    function mkGL(canvas) {
      const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false })
      if (!gl) return null
      function sh(type, src) {
        const s = gl.createShader(type)
        gl.shaderSource(s, src); gl.compileShader(s)
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))
        return s
      }
      function prog(fs) {
        const p = gl.createProgram()
        gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs))
        gl.bindAttribLocation(p, 0, 'aP'); gl.linkProgram(p)
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p))
        const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS)
        for (let i = 0; i < n; i++) { const nm = gl.getActiveUniform(p, i).name; u[nm] = gl.getUniformLocation(p, nm) }
        return { p, u }
      }
      function tex(mip) {
        const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        return t
      }
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
      return { gl, persist: prog(FS_PERSIST), crt: prog(FS_CRT), cur: tex(false), acc: [tex(true), tex(true)],
        fbo: [gl.createFramebuffer(), gl.createFramebuffer()], src: 0 }
    }

    let fontReady = null
    const screens = new Set()
    function loadFont() {
      if (fontReady) return fontReady
      try {
        if (!document.querySelector('link[href*="galmuri"]')) {
          const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = GALMURI
          document.head.appendChild(l)
        }
      } catch (e) { /* the bitmap font is a nicety; monospace fallback is fine */ }
      if (document.fonts && document.fonts.addEventListener) {
        document.fonts.addEventListener('loadingdone', () => { screens.forEach((s) => s.fontChanged()) })
      }
      const fl = document.fonts && document.fonts.load ? document.fonts.load('11px "GalmuriMono11"', '가A').catch(() => {}) : Promise.resolve()
      fontReady = Promise.race([fl, new Promise((r) => setTimeout(r, 2500))])
      return fontReady
    }

    /* ================================================================ *
     * 2. CrtScreen
     * ================================================================ */

    // Brightness of each entry role on the text canvas (the shader tints it).
    const LUM = { user: 0.74, ai: 1.0, think: 0.46, tool: 0.72, result: 0.62, sys: 0.5, err: 0.9 }
    const PREFIX = { user: '> ' }
    // Line markers inside entry text, laid out by CrtScreen.layout:
    // box top (rest of line = label), box bottom, box body line, quoted line with a left bar.
    const BOX_TOP = '\u0001', BOX_BOT = '\u0002', BOX_MID = '\u0003', BAR = '\u0004'
    // Table markers: start (rest = column aligns "l,c,r"), row (cells joined by
    // CELL), header separator, end. A <br> inside a cell is BR.
    const TABLE = '\u0005', TROW = '\u0006', TSEP = '\u0007', TEND = '\u000e', CELL = '\u001f', BR = '\u000b'

    function CrtScreen(el, opts) {
      this.el = el
      this.themeName = THEMES[opts.theme] ? opts.theme : DEFAULT_THEME
      this.theme = THEMES[this.themeName]
      this.fontPx = opts.fontPx || 11
      this.pxDiv = opts.pxDiv || SIZE_STEPS[DEFAULT_SIZE]
      this.osd = null
      this.entries = []; this.status = 'READY'; this.title = ''; this.footer = ''
      this.thinking = null; this.live = false
      this.reveal = { key: null, shown: Infinity }
      this.scroll = 0; this.maxScroll = 0; this.total = 0; this.wacc = 0; this.rows = 10
      this.mcache = new Map(); this.dirty = true; this.lastMut = 0; this.visible = true
      this.reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      this.raf = 0; this.lt = 0; this.key = ''; this.spinK = -1; this.dead = false

      this.txt = document.createElement('canvas')
      this.ctx = this.txt.getContext('2d')
      this.out = document.createElement('canvas')
      this.out.setAttribute('aria-hidden', 'true')
      Object.assign(this.out.style, { display: 'block', width: '100%', height: '100%' })
      el.appendChild(this.out)
      try { this.g = mkGL(this.out) } catch (e) { console.warn('[dsh-crt] WebGL2 failed, falling back to 2D', e); this.g = null }
      if (!this.g) {
        el.removeChild(this.out); this.out = this.txt
        this.txt.setAttribute('aria-hidden', 'true')
        Object.assign(this.txt.style, { display: 'block', width: '100%', height: '100%', imageRendering: 'pixelated' })
        el.appendChild(this.txt)
      }

      const self = this
      this._frame = (t) => self.frame(t)
      this._off = []
      const on = (target, type, fn, o) => { target.addEventListener(type, fn, o); this._off.push(() => target.removeEventListener(type, fn, o)) }

      // Scrollback: wheel, touch, keyboard. At either end the event passes on.
      const stepPx = () => Math.round(self.fontPx * 1.4) * (self.px || 1)
      const consume = (dy) => {
        const dir = dy > 0 ? -1 : 1 // scroll counts lines up from the bottom
        if (dir > 0 && self.scroll >= self.maxScroll) return false
        if (dir < 0 && self.scroll <= 0) return false
        self.wacc += dy
        const st = stepPx(); let moved = false
        while (Math.abs(self.wacc) >= st) {
          const d = self.wacc > 0 ? -1 : 1
          self.wacc -= self.wacc > 0 ? st : -st
          const ns = Math.max(0, Math.min(self.maxScroll, self.scroll + d))
          if (ns !== self.scroll) { self.scroll = ns; moved = true }
        }
        if (moved) self.dirty = true
        return true
      }
      on(el, 'wheel', (e) => {
        const dy = e.deltaY * (e.deltaMode === 1 ? stepPx() : e.deltaMode === 2 ? stepPx() * 10 : 1)
        if (consume(dy)) e.preventDefault()
      }, { passive: false })
      let ty = null
      on(el, 'touchstart', (e) => { ty = e.touches[0].clientY }, { passive: true })
      on(el, 'touchmove', (e) => {
        if (ty === null) return
        const y = e.touches[0].clientY
        if (consume(ty - y)) e.preventDefault()
        ty = y
      }, { passive: false })
      on(el, 'touchend', () => { ty = null })
      on(el, 'keydown', (e) => {
        const rows = self.rows || 10
        const map = { ArrowUp: -1, ArrowDown: 1, PageUp: -rows, PageDown: rows }
        if (e.key in map) { if (consume(map[e.key] * stepPx())) e.preventDefault() }
        else if (e.key === 'End') { self.scroll = 0; self.dirty = true; e.preventDefault() }
        else if (e.key === 'Home') { self.scroll = self.maxScroll; self.dirty = true; e.preventDefault() }
      })

      if (window.ResizeObserver) {
        this._ro = new ResizeObserver(() => self.resize()); this._ro.observe(el)
      } else on(window, 'resize', () => self.resize())
      if (window.IntersectionObserver) {
        this._io = new IntersectionObserver((es) => {
          es.forEach((en) => { self.visible = en.isIntersecting; if (self.visible) self.loop() })
        })
        this._io.observe(el)
      }
      screens.add(this)
      this.resize()
      this.loop()
    }

    CrtScreen.prototype.fontChanged = function () { this.mcache.clear(); this.dirty = true }

    CrtScreen.prototype.setTheme = function (name) {
      if (!THEMES[name] || name === this.themeName) return
      this.themeName = name; this.theme = THEMES[name]; this.dirty = true
    }

    // Change the text size and flash the on-screen display like a monitor menu.
    CrtScreen.prototype.setSize = function (level) {
      const div = SIZE_STEPS[level]
      if (!div) return
      this.osd = { level, until: performance.now() + 1500 }
      if (div !== this.pxDiv) { this.pxDiv = div; this.tw = 0; this.resize() }
      this.dirty = true
      this.loop()
    }

    // data: { entries:[{role,text,key?}], status, title, footer, live, thinking:{t0}|null }
    CrtScreen.prototype.setData = function (data, opts) {
      const prevLen = this.entries.length
      this.entries = data.entries; this.status = data.status
      this.title = data.title; this.footer = data.footer
      this.thinking = data.thinking; this.live = data.live
      // Catch-up typing only for the entry that is streaming right now; the
      // first paint and everything settled show in full.
      const last = this.entries[this.entries.length - 1]
      if (opts && opts.initial) this.reveal = { key: null, shown: Infinity }
      else if (this.live && last && last.key) {
        if (this.reveal.key !== last.key) this.reveal = { key: last.key, shown: 0 }
      } else this.reveal = { key: null, shown: Infinity }
      if (this.entries.length !== prevLen || this.live) this.lastMut = performance.now()
      this.dirty = true
      this.loop()
    }

    CrtScreen.prototype.resize = function () {
      const r = this.el.getBoundingClientRect()
      if (!r.width || !r.height) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      // Text-canvas magnification from the chosen size step (see SIZE_STEPS).
      const px = Math.max(0.75, Math.min(2.5, r.width / this.pxDiv))
      this.px = px
      const tw = Math.round(r.width / px), th = Math.round(r.height / px)
      if (tw === this.tw && th === this.th && dpr === this.dpr) return
      this.tw = tw; this.th = th; this.dpr = dpr
      this.txt.width = tw; this.txt.height = th
      this.mcache.clear()
      if (this.g) {
        this.ow = Math.round(r.width * dpr); this.oh = Math.round(r.height * dpr)
        this.out.width = this.ow; this.out.height = this.oh
        const gl = this.g.gl
        for (let i = 0; i < 2; i++) {
          gl.bindTexture(gl.TEXTURE_2D, this.g.acc[i])
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
          gl.generateMipmap(gl.TEXTURE_2D)
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.g.fbo[i])
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.g.acc[i], 0)
          gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT)
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      }
      this.dirty = true
      this.loop()
    }

    CrtScreen.prototype.mw = function (s) {
      let w = this.mcache.get(s)
      if (w === undefined) { w = this.ctx.measureText(s).width; this.mcache.set(s, w) }
      return w
    }

    CrtScreen.prototype.wrap = function (text, maxW) {
      const out = [], self = this
      text.split('\n').forEach((para) => {
        const toks = para.match(/\S+|\s+/g) || ['']
        let line = '', w = 0
        toks.forEach((tk) => {
          const tw = self.mw(tk)
          if (w + tw <= maxW) { line += tk; w += tw; return }
          if (/^\s+$/.test(tk)) { out.push(line); line = ''; w = 0; return }
          if (tw <= maxW) { out.push(line.replace(/\s+$/, '')); line = tk; w = tw; return }
          Array.from(tk).forEach((ch) => {
            const cw = self.mw(ch)
            if (w + cw > maxW && line) { out.push(line); line = ''; w = 0 }
            line += ch; w += cw
          })
        })
        out.push(line)
      })
      return out
    }

    CrtScreen.prototype.ink = function (v) {
      if (this.g) { const g = Math.round(v * 255); return 'rgb(' + g + ',' + g + ',' + g + ')' }
      const c = this.theme.col
      return 'rgb(' + Math.round(c[0] * v * 255) + ',' + Math.round(c[1] * v * 255) + ',' + Math.round(c[2] * v * 255) + ')'
    }

    function cut(text, n) {
      if (n >= text.length) return text
      const c = text.charCodeAt(n - 1)
      if (c >= 0xd800 && c <= 0xdbff) n++ // keep surrogate pairs whole
      return text.slice(0, n)
    }

    CrtScreen.prototype.draw = function (now) {
      const ctx = this.ctx, W = this.tw, H = this.th, fs = this.fontPx, lh = Math.round(fs * 1.4), self = this
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H)
      ctx.font = fs + 'px ' + FONT; ctx.textBaseline = 'top'
      // No status bars: the bezel already frames the tube, so the text gets the
      // height. The margin only keeps text clear of the curved corners.
      const padX = Math.round(W * 0.07), padY = Math.max(Math.round(H * 0.045), Math.round(fs * 0.8)), maxW = W - padX * 2

      const lines = []; let cursor = null
      const n = this.entries.length
      const inset = this.mw('│ ')
      this.entries.forEach((e, i) => {
        if (i > 0 && !e.tight) lines.push(null)
        const pre = PREFIX[e.role] || '', lum = LUM[e.role] || 1
        const isLast = i === n - 1
        const text = isLast && self.reveal.key === e.key ? cut(e.text, self.reveal.shown) : e.text
        const at = self.layout(text, pre, lum, maxW, lines)
        if (isLast && self.live && self.curOn && !self.thinking && at >= 0) {
          const L = lines[at]
          const x = L.box === 'mid' || L.bar ? padX + inset : padX + (L.x || 0)
          cursor = { line: at, x: x + self.mw(L.text || '') }
        }
      })
      if (this.thinking) {
        const el = now - this.thinking.t0
        lines.push(null)
        lines.push({ segs: [[SPIN[Math.floor(el / 80) % SPIN.length], 1], [' thinking ', 0.5], [(el / 1000).toFixed(1) + 's', 0.75]] })
      }

      const rows = Math.max(1, Math.floor((H - padY * 2) / lh))
      // While scrolled up, new lines keep the viewed position in place.
      if (this.scroll > 0 && lines.length > this.total) this.scroll += lines.length - this.total
      this.total = lines.length; this.rows = rows
      this.maxScroll = Math.max(0, lines.length - rows)
      this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll))
      const start = this.maxScroll - this.scroll
      for (let i = start; i < Math.min(lines.length, start + rows); i++) {
        const L = lines[i]; if (!L) continue
        const y = padY + (i - start) * lh
        if (L.box) { this.drawBox(L, padX, padX + maxW, y, lh, fs, inset); continue }
        if (L.table) { this.drawTable(L, padX, y, lh, fs); continue }
        if (L.bar) {
          const top = y - Math.floor((lh - fs) / 2)
          ctx.fillStyle = this.ink(L.lum * 0.7)
          ctx.fillRect(padX + Math.round(this.mw('│') / 2), top, 1, lh)
          ctx.fillStyle = this.ink(L.lum)
          ctx.fillText(L.text, padX + inset, y)
          continue
        }
        if (L.segs) {
          let sx = padX
          L.segs.forEach((sg) => { ctx.fillStyle = self.ink(sg[1]); ctx.fillText(sg[0], Math.round(sx), y); sx += self.mw(sg[0]) })
          continue
        }
        ctx.fillStyle = this.ink(L.lum)
        if (L.pre) ctx.fillText(L.pre, padX, y)
        ctx.fillText(L.text, Math.round(padX + L.x), y)
      }
      if (this.maxScroll > 0) { // scrollbar
        const trackY = padY, trackH = rows * lh, bx = W - Math.round(padX * 0.45)
        const th2 = Math.max(6, Math.round(trackH * rows / lines.length))
        const ty2 = trackY + Math.round((trackH - th2) * (start / this.maxScroll))
        ctx.fillStyle = this.ink(0.12); ctx.fillRect(bx, trackY, 2, trackH)
        ctx.fillStyle = this.ink(this.scroll > 0 ? 0.7 : 0.35); ctx.fillRect(bx - 1, ty2, 4, th2)
      }
      if (cursor && cursor.line >= start && cursor.line < start + rows) {
        ctx.fillStyle = this.ink(0.95)
        ctx.fillRect(Math.round(cursor.x), padY + (cursor.line - start) * lh, Math.round(this.mw('M')), fs + 1)
      }

      // On-screen display after a size change: "SIZE ███░░"
      if (this.osd && now < this.osd.until) {
        const n = SIZE_STEPS.length, lv = this.osd.level
        const label = 'SIZE ', bars = '█'.repeat(lv + 1) + '░'.repeat(n - lv - 1)
        const w = this.mw(label) + this.mw(bars), bx = Math.round((W - w) / 2), by = H - padY - lh * 2
        ctx.fillStyle = '#000'; ctx.fillRect(bx - fs, by - Math.round(fs * 0.6), Math.round(w) + fs * 2, lh + Math.round(fs * 0.7))
        ctx.fillStyle = this.ink(0.55); ctx.fillRect(bx - fs, by - Math.round(fs * 0.6), Math.round(w) + fs * 2, 1)
        ctx.fillRect(bx - fs, by + lh + Math.round(fs * 0.1) - 1, Math.round(w) + fs * 2, 1)
        ctx.fillStyle = this.ink(0.7); ctx.fillText(label, bx, by)
        ctx.fillStyle = this.ink(1); ctx.fillText(bars, bx + this.mw(label), by)
      }
    }

    // Turn one entry's text (with BOX_*/BAR markers) into screen lines.
    // Returns the index of the last line carrying text, for the cursor.
    CrtScreen.prototype.layout = function (text, pre, lum, maxW, lines) {
      const inset = this.mw('│ '), preW = this.mw(pre)
      let open = false, first = true, last = -1, table = null
      text.split('\n').forEach((raw) => {
        const c = raw.charAt(0)
        if (c === TABLE) { table = { aligns: raw.slice(1).split(','), rows: [], head: 0 }; return }
        if (table) {
          if (c === TROW) { table.rows.push(raw.slice(1).split(CELL)); return }
          if (c === TSEP) { table.head = table.rows.length; return }
          if (c === TEND) { this.layoutTable(table, lum, maxW, lines); table = null; return }
        }
        if (c === BOX_TOP) { lines.push({ box: 'top', label: raw.slice(1), lum }); open = true; last = lines.length - 1; return }
        if (c === BOX_BOT) { if (open) lines.push({ box: 'bot', lum }); open = false; return }
        if (c === BOX_MID) {
          this.wrap(raw.slice(1), maxW - inset * 2).forEach((s) => { lines.push({ box: 'mid', text: s, lum }); last = lines.length - 1 })
          return
        }
        if (c === BAR) {
          this.wrap(raw.slice(1), maxW - inset).forEach((s) => { lines.push({ bar: true, text: s, lum }); last = lines.length - 1 })
          return
        }
        this.wrap(raw, maxW - preW).forEach((s, j) => {
          lines.push({ pre: first && j === 0 ? pre : '', text: s, x: preW, lum }); last = lines.length - 1
        })
        first = false
      })
      if (table) this.layoutTable(table, lum, maxW, lines) // a table still streaming
      if (open) lines.push({ box: 'bot', lum }) // a code block still streaming
      return last
    }

    // Lay a table out as grid rows. Column widths come from the measured cell
    // text; when the grid is wider than the screen, the widest columns give
    // way first and their cells wrap. Each line carries the column rule
    // positions `b` (relative to the left margin).
    CrtScreen.prototype.layoutTable = function (t, lum, maxW, lines) {
      const ncol = t.rows.reduce((n, r) => Math.max(n, r.length), 0)
      if (!ncol) return
      const pad = this.mw(' '), minW = this.mw('MMM')
      const cellText = (r, j) => (r[j] || '').split(BR)
      const nat = new Array(ncol).fill(minW)
      t.rows.forEach((r) => { for (let j = 0; j < ncol; j++) cellText(r, j).forEach((s) => { nat[j] = Math.max(nat[j], Math.ceil(this.mw(s))) }) })
      // fair share: columns narrower than an equal split keep their width
      let avail = maxW - (ncol + 1) - ncol * pad * 2 - 2
      const w = nat.slice()
      if (nat.reduce((a, b) => a + b, 0) > avail) {
        const order = nat.map((v, j) => j).sort((a, b) => nat[a] - nat[b])
        let left = ncol
        order.forEach((j) => {
          const share = Math.max(minW, Math.floor(avail / left))
          w[j] = Math.min(nat[j], share); avail -= w[j]; left--
        })
      }
      const b = [0]
      for (let j = 0; j < ncol; j++) b.push(b[j] + 1 + pad * 2 + w[j])
      const aligns = t.aligns
      const base = { table: true, b, w, aligns, pad, lum }
      const rows = t.rows.map((r) => {
        const wrapped = []
        for (let j = 0; j < ncol; j++) {
          const parts = []
          cellText(r, j).forEach((s) => { this.wrap(s, w[j]).forEach((p) => parts.push(p)) })
          wrapped.push(parts)
        }
        return wrapped
      })
      const height = (wr) => wr.reduce((n, p) => Math.max(n, p.length), 1)
      // Rule between body rows only when some row spans several lines;
      // otherwise rows read fine without and the table stays compact.
      const ruled = rows.some((wr, i) => i >= t.head && height(wr) > 1)
      lines.push(Object.assign({ rule: 'top' }, base))
      rows.forEach((wr, i) => {
        if ((i === t.head && t.head > 0) || (ruled && i > t.head)) lines.push(Object.assign({ rule: 'sep' }, base))
        for (let k = 0, n = height(wr); k < n; k++) {
          lines.push(Object.assign({ rule: 'row', cells: wr.map((p) => p[k] || ''), head: i < t.head }, base))
        }
      })
      lines.push(Object.assign({ rule: 'bot' }, base))
    }

    CrtScreen.prototype.drawTable = function (L, x0, y, lh, fs) {
      const ctx = this.ctx
      const top = y - Math.floor((lh - fs) / 2), mid = top + Math.floor(lh / 2)
      const xs = L.b.map((v) => x0 + Math.round(v)), xl = xs[0], xr = xs[xs.length - 1]
      ctx.fillStyle = this.ink(L.lum * 0.6)
      if (L.rule === 'top') {
        ctx.fillRect(xl, mid, xr - xl + 1, 2)
        xs.forEach((x) => ctx.fillRect(x, mid, 1, top + lh - mid))
      } else if (L.rule === 'sep') {
        xs.forEach((x) => ctx.fillRect(x, top, 1, lh))
        ctx.fillRect(xl, mid, xr - xl + 1, 2)
      } else if (L.rule === 'bot') {
        xs.forEach((x) => ctx.fillRect(x, top, 1, mid - top + 1))
        ctx.fillRect(xl, mid, xr - xl + 1, 2)
      } else {
        xs.forEach((x) => ctx.fillRect(x, top, 1, lh))
        ctx.fillStyle = this.ink(L.head ? Math.min(1, L.lum * 1.1) : L.lum * 0.9)
        L.cells.forEach((s, j) => {
          if (!s) return
          const cw = this.mw(s), a = L.aligns[j]
          let x = xs[j] + 1 + L.pad
          if (a === 'r') x += L.w[j] - cw
          else if (a === 'c') x += Math.round((L.w[j] - cw) / 2)
          ctx.fillText(s, Math.round(x), y)
        })
      }
    }

    // Box rows are drawn with 1px rules on the text canvas so they line up
    // whatever the glyph widths; the CRT pass makes them glow like text.
    CrtScreen.prototype.drawBox = function (L, x0, x1, y, lh, fs, inset) {
      const ctx = this.ctx
      const top = y - Math.floor((lh - fs) / 2), mid = top + Math.floor(lh / 2)
      const xl = x0 + Math.round(this.mw('│') / 2), xr = x1 - Math.round(this.mw('│') / 2) - 1
      ctx.fillStyle = this.ink(L.lum * 0.6)
      // Horizontal rules are 2px: a 1px rule breaks up where the curved glass
      // maps it across two source rows.
      if (L.box === 'top') {
        ctx.fillRect(xl, mid, xr - xl + 1, 2)
        ctx.fillRect(xl, mid, 1, top + lh - mid); ctx.fillRect(xr, mid, 1, top + lh - mid)
        if (L.label) {
          const lx = xl + Math.round(this.mw('─') * 1.5), avail = xr - lx - Math.round(this.mw('─') * 2)
          let t = ' ' + L.label + ' '
          while (this.mw(t) > avail && t.length > 4) t = t.slice(0, -3) + '… '
          ctx.fillStyle = '#000'; ctx.fillRect(lx, top, Math.ceil(this.mw(t)), lh)
          ctx.fillStyle = this.ink(L.lum * 0.85); ctx.fillText(t, lx, y)
        }
      } else if (L.box === 'mid') {
        ctx.fillRect(xl, top, 1, lh); ctx.fillRect(xr, top, 1, lh)
        ctx.fillStyle = this.ink(L.lum); ctx.fillText(L.text, x0 + inset, y)
      } else {
        ctx.fillRect(xl, top, 1, mid - top + 1); ctx.fillRect(xr, top, 1, mid - top + 1)
        ctx.fillRect(xl, mid, xr - xl + 1, 2)
      }
    }

    CrtScreen.prototype.render = function (time, dt) {
      const g = this.g, gl = g.gl, s = g.src, d = 1 - s
      const tau = this.reduce ? 0.02 : this.theme.tau
      // 1) persistence pass
      gl.bindFramebuffer(gl.FRAMEBUFFER, g.fbo[d])
      gl.viewport(0, 0, this.tw, this.th)
      gl.useProgram(g.persist.p)
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, g.cur)
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, g.acc[s])
      gl.uniform1i(g.persist.u.uCur, 0); gl.uniform1i(g.persist.u.uPrev, 1)
      gl.uniform2f(g.persist.u.uRes, this.tw, this.th)
      gl.uniform1f(g.persist.u.uDecay, Math.exp(-dt / tau))
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.bindTexture(gl.TEXTURE_2D, g.acc[d]); gl.generateMipmap(gl.TEXTURE_2D)
      // 2) CRT pass
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, this.ow, this.oh)
      gl.useProgram(g.crt.p)
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, g.acc[d])
      const u = g.crt.u
      gl.uniform1i(u.uTex, 0)
      gl.uniform2f(u.uOut, this.ow, this.oh); gl.uniform2f(u.uSrc, this.tw, this.th)
      gl.uniform1f(u.uTime, time % 1000); gl.uniform3fv(u.uCol, this.theme.col)
      gl.uniform1f(u.uMotion, this.reduce ? 0 : 1); gl.uniform1f(u.uDpr, this.dpr)
      gl.uniform1f(u.uK, this.theme.k); gl.uniform1f(u.uVfd, this.theme.vfd)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      g.src = d
    }

    CrtScreen.prototype.upload = function () {
      const gl = this.g.gl
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.g.cur)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.txt)
    }

    CrtScreen.prototype.loop = function () {
      if (!this.raf && !this.dead) this.raf = requestAnimationFrame(this._frame)
    }

    CrtScreen.prototype.frame = function (now) {
      this.raf = 0
      if (this.dead || !this.visible || !this.tw) return
      this.raf = requestAnimationFrame(this._frame)
      const dt = Math.min(0.1, (now - (this.lt || now)) / 1000); this.lt = now

      // Catch up with streamed text: fast when far behind, never below ~60 chars/s.
      const last = this.entries[this.entries.length - 1]
      if (last && this.reveal.key === last.key && this.reveal.shown < last.text.length) {
        const rem = last.text.length - this.reveal.shown
        this.reveal.shown += this.reduce ? rem : Math.max(1, Math.ceil(Math.max(rem * dt * 6, 60 * dt)))
        this.lastMut = now; this.dirty = true
      }
      const sk = this.thinking ? Math.floor((now - this.thinking.t0) / 80) : ''
      const cur = (now - this.lastMut < 450) || Math.floor(now / 530) % 2 === 0
      const osdOn = !!(this.osd && now < this.osd.until)
      const key = sk + '|' + cur + '|' + osdOn
      if (this.dirty || key !== this.key) {
        this.key = key; this.dirty = false; this.curOn = cur
        this.draw(now); if (this.g) this.upload()
      }
      if (this.g) this.render(now / 1000, dt)
    }

    CrtScreen.prototype.destroy = function () {
      this.dead = true
      if (this.raf) cancelAnimationFrame(this.raf)
      this.raf = 0
      this._off.forEach((f) => f())
      if (this._ro) this._ro.disconnect()
      if (this._io) this._io.disconnect()
      screens.delete(this)
      if (this.g) {
        const ext = this.g.gl.getExtension('WEBGL_lose_context')
        if (ext) ext.loseContext()
      }
      if (this.out.parentNode) this.out.parentNode.removeChild(this.out)
    }

    /* ================================================================ *
     * 3. toTerminal: Chat snapshot -> terminal entries
     * ================================================================ */

    function clip(s, n) {
      s = String(s == null ? '' : s)
      return s.length > n ? s.slice(0, n - 1) + '…' : s
    }

    function firstLine(s) {
      s = String(s || '').trim()
      const i = s.indexOf('\n')
      return i === -1 ? s : s.slice(0, i)
    }

    function contentText(content) {
      return (content || []).map((b) => {
        if (!b || typeof b !== 'object') return ''
        if (b.type === 'text') return b.text || ''
        return '[' + (b.type || 'block') + ']'
      }).join('\n').trim()
    }

    // Inline markdown: links, emphasis and code spans flattened to text.
    function inlineMd(s) {
      return s
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '[image$1]')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 <$2>')
        .replace(/(\*\*|__)(.+?)\1/g, '$2')
        .replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, '$1$2')
        .replace(/`([^`]+)`/g, '$1')
    }

    const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.indexOf('-') !== -1
    const isTableRow = (l) => l.indexOf('|') !== -1 && l.trim() !== ''
    function tableCells(l) {
      let s = l.trim()
      if (s.charAt(0) === '|') s = s.slice(1)
      if (s.charAt(s.length - 1) === '|' && s.charAt(s.length - 2) !== '\\') s = s.slice(0, -1)
      return s.split(/(?<!\\)\|/).map((c) => inlineMd(c.trim().replace(/\\\|/g, '|')).replace(/<br\s*\/?>/gi, BR))
    }
    function tableAligns(l) {
      return tableCells(l).map((c) => {
        const left = c.charAt(0) === ':', right = c.charAt(c.length - 1) === ':'
        return left && right ? 'c' : right ? 'r' : 'l'
      }).join(',')
    }

    // Light markdown flattening, after the blog's chatlog block rules.
    function plain(md) {
      const out = []
      let fence = false
      const src = String(md || '').replace(/\r/g, '').split('\n')
      for (let i = 0; i < src.length; i++) {
        const line = src[i]
        if (/^\s*(```|~~~)/.test(line)) {
          fence = !fence
          out.push(fence ? BOX_TOP + (line.replace(/^\s*(```|~~~)/, '').trim() || 'code') : BOX_BOT)
          continue
        }
        if (fence) { out.push(BOX_MID + line.replace(/\t/g, '  ')); continue }
        // GFM table: a row, then a separator row, then rows until a blank or pipeless line.
        if (isTableRow(line) && i + 1 < src.length && isTableSep(src[i + 1])) {
          out.push(TABLE + tableAligns(src[i + 1]))
          out.push(TROW + tableCells(line).join(CELL))
          out.push(TSEP)
          i += 2
          while (i < src.length && isTableRow(src[i]) && !/^\s*(```|~~~)/.test(src[i])) { out.push(TROW + tableCells(src[i]).join(CELL)); i++ }
          out.push(TEND)
          i--
          continue
        }
        let s = line
        s = s.replace(/^(#{1,6})\s+/, '## ')
        s = s.replace(/^(\s*)[*+]\s+/, '$1- ')
        s = s.replace(/^\s*>\s?/, '| ')
        s = s.replace(/^\s*([-*_])(\s*\1){2,}\s*$/, '────────')
        out.push(inlineMd(s))
      }
      return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    }

    // One readable line for a tool call's arguments.
    function argsSummary(argsRaw) {
      if (!argsRaw) return ''
      try {
        const a = JSON.parse(argsRaw)
        if (a && typeof a === 'object') {
          for (const k of ['command', 'cmd', 'path', 'file_path', 'filePath', 'query', 'url', 'pattern', 'prompt', 'description']) {
            if (typeof a[k] === 'string' && a[k]) return firstLine(a[k])
          }
          const s = Object.values(a).find((v) => typeof v === 'string' && v)
          if (s) return firstLine(s)
          return firstLine(JSON.stringify(a))
        }
      } catch (e) { /* partial or non-JSON arguments */ }
      return firstLine(argsRaw)
    }

    function parseArgs(argsRaw) {
      try { const a = JSON.parse(argsRaw); return a && typeof a === 'object' ? a : null } catch (e) { return null }
    }

    // Header row of a tool call: "● bash · List plugin files"
    function toolTitle(name, argsRaw) {
      const a = parseArgs(argsRaw)
      const what = a && typeof a.description === 'string' && a.description ? a.description : argsSummary(argsRaw)
      return '● ' + (name || 'tool') + (what ? ' · ' + clip(what, 120) : '')
    }

    // Label on the output box: the command itself for shells, else name + main argument.
    function toolLabel(name, argsRaw) {
      const a = parseArgs(argsRaw)
      if (a && typeof a.command === 'string' && a.command) return '$ ' + firstLine(a.command)
      return (name || 'tool') + (argsRaw ? ' ' + argsSummary(argsRaw) : '')
    }

    const THINK_LINES = 8
    const OUTPUT_LINES = 10

    function pushAssistant(entries, blocks, keyBase, live, calls) {
      blocks.forEach((b, i) => {
        const key = keyBase + ':' + i
        const isLast = i === blocks.length - 1
        if (b.kind === 'text') {
          const text = plain(b.text)
          if (text) entries.push({ role: 'ai', text, key })
        } else if (b.kind === 'reasoning') {
          const ls = String(b.text || '').split('\n').filter((l) => l.trim())
          if (!ls.length) return
          const streaming = live && isLast
          // While thinking, show everything so the text only ever grows at the
          // end (the catch-up typing and phosphor persistence rely on that; a
          // sliding window reflows the block every line and smears). Once
          // done, fold to the opening lines.
          const shown = streaming || ls.length <= THINK_LINES + 1 ? ls : ls.slice(0, THINK_LINES)
          const body = shown.map((l) => BAR + l)
          const more = ls.length - shown.length
          if (more > 0) body.push(BAR + '… +' + more + ' lines')
          entries.push({ role: 'think', text: [streaming ? '∴ thinking…' : '∴ thought'].concat(body).join('\n'), key })
        } else if (b.kind === 'tool-call') {
          if (calls) calls.add(b.callId)
          entries.push({ role: 'tool', text: toolTitle(b.name, b.argsRaw), key })
        } else if (b.kind === 'image') {
          entries.push({ role: 'sys', text: '[image]', key })
        }
      })
    }

    function toolResultText(n) {
      const name = n.name || (n.call && n.call.name) || ''
      const argsRaw = n.call ? n.call.argsRaw : ''
      let label = toolLabel(name, argsRaw)
      if (n.isError) label = '✗ ' + label
      const out = contentText(n.content).replace(/\s+$/, '').split('\n')
      // Hide only when it saves more than one line.
      const fits = out.length <= OUTPUT_LINES + 1
      const body = out.length === 1 && !out[0] ? ['(no output)'] : fits ? out : out.slice(0, OUTPUT_LINES)
      if (!fits) body.push('… +' + (out.length - OUTPUT_LINES) + ' lines')
      if (n.isError && n.error) body.push('error: ' + n.error.code + (n.error.reason ? ' · ' + n.error.reason : ''))
      return [BOX_TOP + label].concat(body.map((l) => BOX_MID + clip(l, 400)), [BOX_BOT]).join('\n')
    }

    function toTerminal(chat, session) {
      const entries = []
      const legacy = chat && chat.legacy
      const nodes = legacy ? legacy.nodes : []
      let model = '', turns = 0, retries = 0
      const calls = new Set() // call ids whose header row is already on screen

      nodes.forEach((n) => {
        const key = n.kind + ':' + n.seq
        switch (n.kind) {
          case 'user': turns++; entries.push({ role: 'user', text: contentText(n.content), key }); break
          case 'steering': entries.push({ role: 'user', text: contentText(n.content), key }); break
          case 'assistant': {
            const m = (n.requestConfig && n.requestConfig.model) || (n.providerMetadata && n.providerMetadata.model)
            if (m) model = m
            pushAssistant(entries, n.blocks || [], key, false, calls)
            if (n.interrupted) entries.push({ role: 'sys', text: '[stopped]', key: key + ':stop', tight: true })
            break
          }
          case 'tool-result':
            if (!calls.has(n.callId)) entries.push({ role: 'tool', text: toolTitle(n.name, n.call ? n.call.argsRaw : ''), key: key + ':head' })
            entries.push({ role: n.isError ? 'err' : 'result', text: toolResultText(n), key, tight: true })
            break
          case 'turn-error':
            entries.push({ role: 'err', text: '! ERROR' + (n.code ? ' ' + n.code : '') + (n.message ? ': ' + clip(n.message, 200) : ''), key })
            break
          case 'turn-max-tokens': entries.push({ role: 'err', text: '! output token limit reached', key }); break
          case 'model-retry': {
            retries++
            const prev = entries[entries.length - 1]
            const text = '~ retrying model request (' + retries + ')'
            if (prev && prev.retry) { prev.text = text } else entries.push({ role: 'sys', text, key, retry: true })
            break
          }
          case 'command': {
            const out = n.outcome ? (n.outcome.kind === 'error' ? '  ↳ error ' : '  ↳ ') + clip(firstLine(n.outcome.text || n.outcome.kind), 140) : '  ↳ running…'
            entries.push({ role: 'tool', text: '/' + (n.name || 'command') + (n.args || '') + '\n' + out, key })
            break
          }
          case 'compaction': entries.push({ role: 'sys', text: '──── context compacted ────', key }); break
          default: break // context injections and unknown surface events stay off the screen
        }
        if (n.kind !== 'model-retry') retries = 0
      })

      const snap = session || {}
      ;(snap.pendingSubmissions || []).forEach((p) => {
        if (p.placement === 'transcript' && p.text) entries.push({ role: 'user', text: p.text, key: 'pending:' + p.requestId })
      })

      const partial = legacy && legacy.partial
      const running = !!snap.running
      let live = false
      if (partial && partial.blocks && partial.blocks.length) {
        const before = entries.length
        pushAssistant(entries, partial.blocks, 'partial:' + partial.turn + ':' + partial.step, true, calls)
        live = entries.length > before
      }
      const runningCalls = legacy ? legacy.runningCalls || [] : []
      runningCalls.forEach((c) => {
        if (!calls.has(c.callId)) entries.push({ role: 'tool', text: toolTitle(c.name, c.argsRaw || ''), key: 'call:' + c.callId })
        const label = c.phase === 'preparing' ? 'preparing…' : toolLabel(c.name, c.argsRaw || '')
        entries.push({ role: 'result', text: BOX_TOP + label + '\n' + BOX_MID + (c.phase === 'preparing' ? '…' : 'running…'), key: 'run:' + c.callId, tight: true })
      })

      let status = 'READY'
      if (snap.openState === 'loading') status = 'LOADING'
      else if (snap.openState === 'error') status = 'ERROR'
      else if (running) status = runningCalls.length ? 'RUNNING' : live ? 'STREAMING' : 'THINKING'

      return {
        entries,
        status,
        live: running && live && !runningCalls.length,
        thinking: running && !live && !runningCalls.length ? { t0: 0 } : null,
        title: (model || 'deepseek harness') + ' // crt',
        footer: 'TURN ' + String(turns).padStart(3, '0'),
      }
    }

    /* ================================================================ *
     * 4. CrtView + apply
     * ================================================================ */

    const EMPTY = { getSnapshot: () => undefined, subscribe: () => () => {} }

    // Sources may be class instances (Session), so call their methods bound.
    function useSource(source) {
      const s = useMemo(() => {
        if (!source || typeof source.getSnapshot !== 'function' || typeof source.subscribe !== 'function') return EMPTY
        return { getSnapshot: () => source.getSnapshot(), subscribe: (l) => source.subscribe(l) }
      }, [source])
      return useSyncExternalStore(s.subscribe, s.getSnapshot)
    }

    function readTheme() {
      try { const t = window.localStorage.getItem(THEME_KEY); if (t && THEMES[t]) return t } catch (e) { /* storage blocked */ }
      return DEFAULT_THEME
    }
    function saveTheme(t) {
      try { window.localStorage.setItem(THEME_KEY, t) } catch (e) { /* storage blocked */ }
    }
    function readSize() {
      try { const s = parseInt(window.localStorage.getItem(SIZE_KEY), 10); if (s >= 0 && s < SIZE_STEPS.length) return s } catch (e) { /* storage blocked */ }
      return DEFAULT_SIZE
    }
    function saveSize(s) {
      try { window.localStorage.setItem(SIZE_KEY, String(s)) } catch (e) { /* storage blocked */ }
    }

    function rgb(col, a) {
      return 'rgba(' + Math.round(col[0] * 255) + ',' + Math.round(col[1] * 255) + ',' + Math.round(col[2] * 255) + ',' + a + ')'
    }

    function CrtView(props) {
      const chat = useSource(props.crtChat)
      const session = useSource(props.crtSession)
      const hostRef = useRef(null)
      const screenRef = useRef(null)
      const thinkStart = useRef(0)
      const [theme, setTheme] = useState(readTheme)
      const [size, setSize] = useState(readSize)
      const [ready, setReady] = useState(false)

      useEffect(() => {
        let alive = true
        loadFont().then(() => {
          if (!alive || !hostRef.current) return
          screenRef.current = new CrtScreen(hostRef.current, { theme: readTheme(), pxDiv: SIZE_STEPS[readSize()] })
          setReady(true)
        })
        return () => {
          alive = false
          if (screenRef.current) { screenRef.current.destroy(); screenRef.current = null }
        }
      }, [])

      useEffect(() => {
        saveTheme(theme)
        if (screenRef.current) screenRef.current.setTheme(theme)
      }, [theme, ready])

      const sizeChanged = useRef(false)
      useEffect(() => {
        saveSize(size)
        // the OSD shows only for a user change, not on the first paint
        if (screenRef.current && sizeChanged.current) screenRef.current.setSize(size)
      }, [size])
      const changeSize = (d) => {
        sizeChanged.current = true
        setSize((s) => Math.max(0, Math.min(SIZE_STEPS.length - 1, s + d)))
      }

      const initial = useRef(true)
      useEffect(() => {
        const s = screenRef.current
        if (!s) return
        const data = toTerminal(chat, session)
        if (data.thinking) {
          if (!thinkStart.current) thinkStart.current = performance.now()
          data.thinking.t0 = thinkStart.current
        } else thinkStart.current = 0
        s.setData(data, { initial: initial.current })
        initial.current = false
      }, [chat, session, ready])

      const col = THEMES[theme].col
      const LABEL_FONT = '600 10px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'

      // The monitor's push buttons on the chin; `on` = pressed in.
      const pushStyle = (on, extra) => Object.assign({
        display: 'flex', alignItems: 'center', gap: '6px',
        font: LABEL_FONT, letterSpacing: '0.12em', color: on ? '#b9b9bd' : '#7a7a80',
        padding: '5px 9px 4px', cursor: 'pointer', borderRadius: '4px',
        border: '1px solid #0e0e10',
        background: on ? 'linear-gradient(#1e1e21,#262629)' : 'linear-gradient(#36363a,#28282b)',
        boxShadow: on
          ? 'inset 0 2px 3px rgba(0,0,0,.7)'
          : 'inset 0 1px 0 rgba(255,255,255,.08), 0 2px 0 #121214, 0 3px 4px rgba(0,0,0,.4)',
        transform: on ? 'translateY(1px)' : 'none',
      }, extra)

      // Text size rocker: A− / A+. Pressing shows the SIZE bar on screen.
      const sizeButton = (label, d, aria) => {
        const atEnd = d < 0 ? size === 0 : size === SIZE_STEPS.length - 1
        return h('button', {
          key: label,
          type: 'button',
          'aria-label': aria,
          title: aria,
          disabled: atEnd,
          onClick: () => changeSize(d),
          style: pushStyle(false, { letterSpacing: '0.04em', padding: '5px 8px 4px', minWidth: '30px', justifyContent: 'center', opacity: atEnd ? 0.45 : 1, cursor: atEnd ? 'default' : 'pointer' }),
        }, label)
      }

      // Theme switches.
      const button = (name) => {
        const on = name === theme
        return h('button', {
          key: name,
          type: 'button',
          'aria-pressed': on,
          title: THEMES[name].label,
          onClick: () => setTheme(name),
          style: pushStyle(on),
        },
        h('span', { 'aria-hidden': 'true', style: { width: '5px', height: '5px', borderRadius: '50%', background: on ? rgb(THEMES[name].col, 1) : '#1a1a1c', boxShadow: on ? '0 0 6px ' + rgb(THEMES[name].col, 0.9) : 'inset 0 1px 1px rgba(0,0,0,.8)' } }),
        THEMES[name].label)
      }

      return h('div', {
        'data-dsh-plugin': 'dsh-crt',
        style: {
          // monitor casing: dark moulded plastic
          position: 'relative', flex: '1 1 auto', width: '100%', height: '100%', minHeight: '260px',
          boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
          padding: 'clamp(6px, 1.4vw, 13px) clamp(6px, 1.6vw, 15px) 0',
          background: 'radial-gradient(120% 90% at 50% 0%, #3a3a3e 0%, #2a2a2d 45%, #1c1c1f 100%)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,.07), inset 0 -2px 6px rgba(0,0,0,.5)',
          overflow: 'hidden',
        },
      },
      // recessed bezel around the tube
      h('div', {
        style: {
          position: 'relative', flex: '1 1 auto', minHeight: 0,
          padding: 'clamp(4px, 0.7vw, 7px)', borderRadius: '17px',
          background: 'linear-gradient(#141416, #202023)',
          boxShadow: 'inset 0 3px 8px rgba(0,0,0,.85), inset 0 -1px 0 rgba(255,255,255,.06), 0 1px 0 rgba(255,255,255,.05)',
        },
      },
      // the tube face: slightly bulged corners, clipped
      h('div', {
        style: {
          position: 'relative', width: '100%', height: '100%', overflow: 'hidden',
          borderRadius: '13px / 16px', background: '#000',
          boxShadow: '0 0 0 1px #050506, 0 0 24px ' + rgb(col, 0.10),
        },
      },
      h('div', {
        ref: hostRef,
        tabIndex: 0,
        role: 'img',
        'aria-label': 'Conversation shown as a CRT terminal. Arrow keys, Page Up and Page Down scroll.',
        style: { position: 'absolute', inset: 0, outline: 'none' },
      }),
      // glass: a soft reflection and a dark inner rim
      h('div', {
        'aria-hidden': 'true',
        style: {
          position: 'absolute', inset: 0, pointerEvents: 'none', borderRadius: 'inherit',
          background: 'radial-gradient(70% 45% at 28% 12%, rgba(255,255,255,.07), rgba(255,255,255,0) 70%), linear-gradient(160deg, rgba(255,255,255,.035), rgba(255,255,255,0) 40%)',
          boxShadow: 'inset 0 0 18px 6px rgba(0,0,0,.75), inset 0 0 2px 1px rgba(0,0,0,.9)',
        },
      }))),
      // chin: embossed badge, theme buttons, power LED
      h('div', {
        style: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 2px 7px', minHeight: '24px' },
      },
      h('span', {
        style: { font: LABEL_FONT, letterSpacing: '0.28em', color: '#55555a', textShadow: '0 1px 0 rgba(255,255,255,.07), 0 -1px 0 rgba(0,0,0,.6)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      }, 'DEEPSEEK · CRT'),
      h('div', { style: { flex: '1 1 auto' } }),
      h('div', { role: 'group', 'aria-label': 'Text size', style: { display: 'flex', gap: '3px' } },
        sizeButton('A−', -1, 'Smaller text'), sizeButton('A+', 1, 'Larger text')),
      h('span', { 'aria-hidden': 'true', style: { width: '1px', alignSelf: 'stretch', margin: '3px 2px', background: '#141416', boxShadow: '1px 0 0 rgba(255,255,255,.05)' } }),
      h('div', { role: 'group', 'aria-label': 'CRT theme', style: { display: 'flex', gap: '6px' } }, THEME_ORDER.map(button)),
      h('span', {
        'aria-hidden': 'true',
        title: 'power',
        style: { marginLeft: '6px', width: '7px', height: '7px', borderRadius: '50%', flex: '0 0 auto', background: rgb(col, 1), boxShadow: '0 0 4px ' + rgb(col, 1) + ', 0 0 10px ' + rgb(col, 0.6) },
      })))
    }

    return {
      inject: ['slots', 'sessions', 'uiConversation'],
      apply(ctx) {
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'crt',
          order: 10,
          label: () => 'CRT',
          inject: (sessionId) => {
            const binding = ctx.sessions.binding(sessionId)
            if (binding === undefined) throw new Error('dsh-crt: unknown session "' + sessionId + '"')
            return {
              crtChat: ctx.uiConversation.binding(binding).target('chat'),
              crtSession: binding.session,
            }
          },
        }, CrtView))
      },
    }
  },
})
