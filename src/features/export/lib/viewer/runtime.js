/*
 * ORBIT offline viewer runtime.
 * Embedded verbatim into every exported single-file artwork.
 * Reads the panorama and the author's view from the in-page JSON payload only.
 *
 * Two interchangeable viewing paths share one inverse projection and one boundary rule:
 *   gpu      – fragment shader texture sampling (nearest texels + manual bilinear)
 *   software – per-pixel CPU sampling into ImageData
 * Both wrap horizontally, clamp vertically and blend the seam with the same formula,
 * so changing engines alters speed/definition, never the composition.
 */
(function () {
  "use strict";

  var TAU = Math.PI * 2;
  var PI = Math.PI;
  var MAX_SEAM = 0.15;
  var MAX_FEATHER = 0.4;

  function byId(id) {
    return document.getElementById(id);
  }
  function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
  }
  function wrap(value, period) {
    return ((value % period) + period) % period;
  }
  function smoothstep(a, b, x) {
    var t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function finite(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  function num(value, lo, hi, fallback) {
    var n = finite(value, NaN);
    return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
  }
  function parseColor(hex) {
    if (typeof hex !== "string" || !/^#[0-9a-f]{6}$/i.test(hex))
      return [0.914, 0.937, 0.957];
    return [1, 3, 5].map(function (i) {
      return parseInt(hex.slice(i, i + 2), 16) / 255;
    });
  }

  var els = {
    stage: byId("ov-stage"),
    canvas: byId("ov-canvas"),
    loading: byId("ov-loading"),
    error: byId("ov-error"),
    errorText: byId("ov-error-text"),
    notice: byId("ov-notice"),
    poster: byId("ov-poster"),
    title: byId("ov-title"),
    modeLabel: byId("ov-mode-label"),
    engineLabel: byId("ov-engine-label"),
    status: byId("ov-status"),
    meta: byId("ov-meta"),
    planet: byId("ov-planet"),
    tunnel: byId("ov-tunnel"),
    reset: byId("ov-reset"),
    zoomIn: byId("ov-zoom-in"),
    zoomOut: byId("ov-zoom-out"),
    engine: byId("ov-engine"),
    yaw: byId("ov-yaw"),
    pitch: byId("ov-pitch"),
    roll: byId("ov-roll"),
    zoom: byId("ov-zoom"),
    yawOut: byId("ov-yaw-out"),
    pitchOut: byId("ov-pitch-out"),
    rollOut: byId("ov-roll-out"),
    zoomOutLabel: byId("ov-zoom-out-label"),
  };

  var display = els.canvas.getContext("2d");
  var payload = null;
  var author = null;
  var state = null;
  var edge = null;
  var sourceImage = null;
  var sampler = null;
  var gpu = null;
  var engine = "software";
  var enginePref = "auto";
  var interactive = false;
  var frame = 0;
  var noticeTimer = 0;
  var drawCount = 0;
  var failed = false;
  var firstFrameDone = false;
  var fpsEma = 0;

  function fail(message, detail) {
    if (failed) return;
    failed = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    els.loading.hidden = true;
    els.canvas.style.display = "none";
    els.error.hidden = false;
    els.errorText.textContent = message + (detail ? "（" + detail + "）" : "");
    if (payload && typeof payload.poster === "string" && els.poster) {
      els.poster.src = payload.poster;
      els.poster.hidden = false;
      els.status.textContent = "交互查看不可用，但可查看作者视角的静态画面。";
    } else {
      els.status.textContent = "交互查看不可用。";
    }
    els.engineLabel.textContent = "交互查看不可用";
  }

  function showNotice(text, ms) {
    els.notice.textContent = text;
    els.notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () {
      els.notice.hidden = true;
    }, ms || 2800);
  }

  function modeName(mode) {
    return mode === "tunnel" ? "时空隧道" : "小行星";
  }

  function normalizeProjection(raw) {
    raw = raw && typeof raw === "object" ? raw : {};
    return {
      mode: raw.mode === "tunnel" ? "tunnel" : "planet",
      yaw: wrap(num(raw.yaw, 0, 360, 0), 360),
      pitch: num(raw.pitch, -85, 85, 0),
      roll: wrap(num(raw.roll, 0, 360, 0), 360),
      zoom: num(raw.zoom, 0.3, 3, 1),
    };
  }

  function normalizeEdge(raw) {
    raw = raw && typeof raw === "object" ? raw : {};
    return {
      seam: num(raw.seam, 0, MAX_SEAM, 0.025),
      feather: num(raw.feather, 0, MAX_FEATHER, 0),
      background: /^#[0-9a-f]{6}$/i.test(raw.background || "")
        ? raw.background
        : "#e9eff4",
      transparent: raw.transparent === true,
    };
  }

  function readPayload() {
    var node = byId("orbit-payload");
    if (!node) throw new Error("缺少作品数据");
    var data;
    try {
      data = JSON.parse(node.textContent || "");
    } catch (e) {
      throw new Error("作品数据不是有效的 JSON");
    }
    if (!data || data.version !== 1) throw new Error("作品版本不受支持");
    if (
      !data.image ||
      typeof data.image.dataUrl !== "string" ||
      data.image.dataUrl.indexOf("data:image/") !== 0
    )
      throw new Error("作品内没有可用的照片");
    return data;
  }

  function syncControls() {
    els.modeLabel.textContent =
      state.mode === "planet" ? "小行星视角" : "时空隧道视角";
    els.planet.setAttribute(
      "aria-pressed",
      state.mode === "planet" ? "true" : "false",
    );
    els.tunnel.setAttribute(
      "aria-pressed",
      state.mode === "tunnel" ? "true" : "false",
    );
    els.yaw.value = String(Math.round(state.yaw));
    els.pitch.value = String(Math.round(state.pitch));
    els.roll.value = String(Math.round(state.roll));
    els.zoom.value = state.zoom.toFixed(2);
    els.yawOut.textContent = Math.round(state.yaw) + "°";
    els.pitchOut.textContent = Math.round(state.pitch) + "°";
    els.rollOut.textContent = Math.round(state.roll) + "°";
    els.zoomOutLabel.textContent = state.zoom.toFixed(2) + "×";
    els.stage.setAttribute(
      "aria-label",
      "可拖动探索的" +
        (state.mode === "planet" ? "星球全景" : "隧道全景") +
        "。拖动旋转，双指或滚轮缩放，方向键微调，按 0 键恢复作者视角。",
    );
    els.stage.classList.toggle("is-transparent", edge.transparent);
    els.stage.style.setProperty("--ov-matte", edge.background);
  }

  function setState(patch, announce) {
    if (!state) return;
    for (var key in patch)
      if (Object.prototype.hasOwnProperty.call(patch, key))
        state[key] = patch[key];
    syncControls();
    schedule();
    if (announce) els.status.textContent = announce;
  }

  function resetView() {
    if (!author) return;
    setState(
      {
        mode: author.mode,
        yaw: author.yaw,
        pitch: author.pitch,
        roll: author.roll,
        zoom: author.zoom,
      },
      "已恢复作者视角",
    );
  }

  function hasWebGL() {
    try {
      var probe = document.createElement("canvas");
      var gl =
        probe.getContext("webgl") || probe.getContext("experimental-webgl");
      if (!gl) return false;
      var lose = gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
      return true;
    } catch (e) {
      return false;
    }
  }

  var VERTEX_SRC =
    "attribute vec2 aPos;void main(){gl_Position=vec4(aPos,0.0,1.0);}";

  var FRAGMENT_BODY = [
    "uniform sampler2D uTex;",
    "uniform vec2 uSrc;",
    "uniform vec2 uRes;",
    "uniform float uZoom;",
    "uniform float uYaw;",
    "uniform float uRoll;",
    "uniform float uPitch;",
    "uniform float uMode;",
    "uniform float uSeam;",
    "uniform float uFeather;",
    "uniform float uTransparent;",
    "uniform vec3 uBg;",
    "const float TAU=6.28318530718;",
    "const float PI=3.14159265359;",
    "vec4 texAt(vec2 idx){",
    "  float x=mod(idx.x,uSrc.x);",
    "  float y=clamp(idx.y,0.0,uSrc.y-1.0);",
    "  return texture2D(uTex,(vec2(x,y)+0.5)/uSrc);",
    "}",
    "vec4 bilinear(vec2 uv){",
    "  vec2 t=vec2(fract(uv.x)*uSrc.x-0.5,clamp(uv.y*uSrc.y-0.5,0.0,uSrc.y-1.0));",
    "  vec2 i0=floor(t);",
    "  vec2 f=t-i0;",
    "  vec4 a=texAt(i0);",
    "  vec4 b=texAt(i0+vec2(1.0,0.0));",
    "  vec4 c=texAt(i0+vec2(0.0,1.0));",
    "  vec4 d=texAt(i0+vec2(1.0,1.0));",
    "  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);",
    "}",
    "void main(){",
    "  vec2 p=vec2(gl_FragCoord.x,uRes.y-gl_FragCoord.y);",
    "  float unit=min(uRes.x,uRes.y)*0.5;",
    "  vec2 ab=(p-uRes*0.5)/unit/uZoom;",
    "  float theta=2.0*atan(length(ab));",
    "  float ang=atan(ab.y,ab.x)+uRoll;",
    "  vec3 d=vec3(sin(theta)*cos(ang),cos(theta)*(uMode<0.5?-1.0:1.0),sin(theta)*sin(ang));",
    "  float cp=cos(uPitch);",
    "  float sp=sin(uPitch);",
    "  float ry=d.y*cp-d.z*sp;",
    "  d.z=d.y*sp+d.z*cp;",
    "  d.y=ry;",
    "  vec2 uv=vec2(fract(atan(d.z,d.x)/TAU+uYaw/360.0),clamp(0.5-asin(clamp(d.y,-1.0,1.0))/PI,0.0,1.0));",
    "  vec4 rgba=bilinear(uv);",
    "  float seamDist=min(uv.x,1.0-uv.x);",
    "  if(uSeam>0.0&&seamDist<uSeam){",
    "    float mixf=(1.0-smoothstep(0.0,uSeam,seamDist))*0.5;",
    "    rgba=mix(rgba,bilinear(vec2(1.0-uv.x,uv.y)),mixf);",
    "  }",
    "  float radius=length(p-uRes*0.5)/(min(uRes.x,uRes.y)*0.5);",
    "  float fade=uFeather>0.0?(1.0-smoothstep(1.0-uFeather,1.0,radius)):1.0;",
    "  float alpha=rgba.a*fade;",
    "  if(uTransparent>0.5){",
    "    gl_FragColor=vec4(rgba.rgb*alpha,alpha);",
    "  }else{",
    "    gl_FragColor=vec4(rgba.rgb*alpha+uBg*(1.0-alpha),1.0);",
    "  }",
    "}",
  ].join("\n");

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error("shader: " + (log || "compile failed"));
    }
    return sh;
  }

  function buildGpu(image, onLost) {
    var cv = document.createElement("canvas");
    var gl = cv.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL 不可用");

    var program = null;
    var frag = null;
    var precisions = ["highp", "mediump"];
    for (var i = 0; i < precisions.length; i++) {
      try {
        frag = compile(
          gl,
          gl.FRAGMENT_SHADER,
          "precision " + precisions[i] + " float;" + FRAGMENT_BODY,
        );
        program = gl.createProgram();
        gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SRC));
        gl.attachShader(program, frag);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS))
          throw new Error(
            "shader link: " + (gl.getProgramInfoLog(program) || "failed"),
          );
        break;
      } catch (e) {
        program = null;
        if (i === precisions.length - 1) throw e;
      }
    }
    gl.useProgram(program);

    var buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    var aPos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    var u = {};
    [
      "uTex",
      "uSrc",
      "uRes",
      "uZoom",
      "uYaw",
      "uRoll",
      "uPitch",
      "uMode",
      "uSeam",
      "uFeather",
      "uTransparent",
      "uBg",
    ].forEach(function (name) {
      u[name] = gl.getUniformLocation(program, name);
    });
    gl.uniform1i(u.uTex, 0);

    var lost = false;
    cv.addEventListener(
      "webglcontextlost",
      function (event) {
        event.preventDefault();
        if (lost) return;
        lost = true;
        onLost();
      },
      false,
    );

    return {
      canvas: cv,
      draw: function (size, st, ed) {
        if (lost || gl.isContextLost()) return false;
        if (cv.width !== size || cv.height !== size) {
          cv.width = size;
          cv.height = size;
          gl.viewport(0, 0, size, size);
        }
        gl.useProgram(program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform2f(
          u.uSrc,
          image.naturalWidth || image.width,
          image.naturalHeight || image.height,
        );
        gl.uniform2f(u.uRes, size, size);
        gl.uniform1f(u.uZoom, st.zoom);
        gl.uniform1f(u.uYaw, st.yaw);
        gl.uniform1f(u.uRoll, (st.roll * PI) / 180);
        gl.uniform1f(u.uPitch, (st.pitch * PI) / 180);
        gl.uniform1f(u.uMode, st.mode === "planet" ? 0 : 1);
        gl.uniform1f(u.uSeam, ed.seam);
        gl.uniform1f(u.uFeather, ed.feather);
        gl.uniform1f(u.uTransparent, ed.transparent ? 1 : 0);
        var bg = parseColor(ed.background);
        gl.uniform3f(u.uBg, bg[0], bg[1], bg[2]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        return true;
      },
      dispose: function () {
        var ext = gl.getExtension("WEBGL_lose_context");
        if (ext) ext.loseContext();
      },
    };
  }

  function ensureSampler() {
    if (sampler) return sampler;
    var w = sourceImage.naturalWidth || sourceImage.width;
    var h = sourceImage.naturalHeight || sourceImage.height;
    var cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    var ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(sourceImage, 0, 0, w, h);
    sampler = { src: ctx.getImageData(0, 0, w, h).data, w: w, h: h };
    return sampler;
  }

  function bilinearSoftware(u, v, src, W, H, out) {
    var x = u * W - 0.5;
    var y = clamp(v * H - 0.5, 0, H - 1);
    var x0 = Math.floor(x);
    var y0 = Math.floor(y);
    var fx = x - x0;
    var fy = y - y0;
    var xa = ((x0 % W) + W) % W;
    var xb = (((x0 + 1) % W) + W) % W;
    var ya = clamp(y0, 0, H - 1);
    var yb = clamp(y0 + 1, 0, H - 1);
    var w00 = (1 - fx) * (1 - fy);
    var w10 = fx * (1 - fy);
    var w01 = (1 - fx) * fy;
    var w11 = fx * fy;
    var i00 = (ya * W + xa) * 4;
    var i10 = (ya * W + xb) * 4;
    var i01 = (yb * W + xa) * 4;
    var i11 = (yb * W + xb) * 4;
    out[0] = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
    out[1] =
      src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
    out[2] =
      src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
    out[3] =
      src[i00 + 3] * w00 + src[i10 + 3] * w10 + src[i01 + 3] * w01 + src[i11 + 3] * w11;
    return out;
  }

  function sampleSoftware(u, v, ed, primary, opposite) {
    bilinearSoftware(u, v, sampler.src, sampler.w, sampler.h, primary);
    if (ed.seam > 0) {
      var d = Math.min(u, 1 - u);
      if (d < ed.seam) {
        bilinearSoftware(1 - u, v, sampler.src, sampler.w, sampler.h, opposite);
        var mix = (1 - smoothstep(0, ed.seam, d)) * 0.5;
        primary[0] += (opposite[0] - primary[0]) * mix;
        primary[1] += (opposite[1] - primary[1]) * mix;
        primary[2] += (opposite[2] - primary[2]) * mix;
        primary[3] += (opposite[3] - primary[3]) * mix;
      }
    }
    return primary;
  }

  var primaryPixel = [0, 0, 0, 0];
  var oppositePixel = [0, 0, 0, 0];

  function drawSoftware(size, st, ed) {
    var image = display.createImageData(size, size);
    var data = image.data;
    var half = size / 2;
    var unit = half;
    var inv = 1 / unit / st.zoom;
    var roll = (st.roll * PI) / 180;
    var yaw = st.yaw / 360;
    var pitch = (st.pitch * PI) / 180;
    var cosP = Math.cos(pitch);
    var sinP = Math.sin(pitch);
    var sign = st.mode === "planet" ? -1 : 1;
    var feather = ed.feather;
    var transparent = ed.transparent;
    var bg = parseColor(ed.background);
    var br = bg[0] * 255;
    var bgg = bg[1] * 255;
    var bb = bg[2] * 255;
    var radiusScale = 1 / half;
    var i = 0;
    for (var y = 0; y < size; y++) {
      var py = (y + 0.5 - half) * inv;
      for (var x = 0; x < size; x++) {
        var px = (x + 0.5 - half) * inv;
        var theta = 2 * Math.atan(Math.hypot(px, py));
        var ang = Math.atan2(py, px) + roll;
        var vx = Math.sin(theta) * Math.cos(ang);
        var vy0 = Math.cos(theta) * sign;
        var vz0 = Math.sin(theta) * Math.sin(ang);
        var vy = vy0 * cosP - vz0 * sinP;
        var vz = vy0 * sinP + vz0 * cosP;
        var u = Math.atan2(vz, vx) / TAU + yaw;
        u -= Math.floor(u);
        var v = 0.5 - Math.asin(vy < -1 ? -1 : vy > 1 ? 1 : vy) / PI;
        v = v < 0 ? 0 : v > 1 ? 1 : v;
        var rgba = sampleSoftware(u, v, ed, primaryPixel, oppositePixel);
        var radius = Math.hypot(x + 0.5 - half, y + 0.5 - half) * radiusScale;
        var fade = feather > 0 ? 1 - smoothstep(1 - feather, 1, radius) : 1;
        var a = (rgba[3] / 255) * fade;
        i = (y * size + x) * 4;
        if (transparent) {
          data[i] = rgba[0];
          data[i + 1] = rgba[1];
          data[i + 2] = rgba[2];
          data[i + 3] = Math.round(a * 255);
        } else {
          data[i] = rgba[0] * a + br * (1 - a);
          data[i + 1] = rgba[1] * a + bgg * (1 - a);
          data[i + 2] = rgba[2] * a + bb * (1 - a);
          data[i + 3] = 255;
        }
      }
    }
    display.putImageData(image, 0, 0);
  }

  function renderSize() {
    var rect = els.stage.getBoundingClientRect();
    var css = Math.max(120, Math.min(rect.width || 480, rect.height || 480));
    var dpr = window.devicePixelRatio || 1;
    var side;
    if (engine === "gpu") {
      // Texture sampling is cheap per pixel, so honour high-DPI displays.
      side = Math.round(css * Math.min(dpr, 2.5));
      return Math.max(64, Math.min(side, 2600));
    }
    side = Math.round(css * Math.min(dpr, 1.5));
    side = Math.min(side, 900);
    if (interactive) side = Math.max(240, Math.round(side * 0.62));
    return Math.max(64, side);
  }

  function updateLabels(size, ms) {
    var perf = ms > 0 && drawCount > 2 ? " · " + Math.round(ms) + " ms" : "";
    els.engineLabel.textContent =
      (engine === "gpu" ? "纹理采样" : "软件采样") +
      " · " +
      size +
      " × " +
      size +
      perf;
  }

  function announceEngine() {
    els.status.textContent =
      engine === "gpu"
        ? "已启用纹理采样，高分屏下保持清晰。"
        : "已启用软件采样：任何设备都能拖动探索，拖动时自动降低精度、松手后恢复清晰。";
  }

  function draw() {
    frame = 0;
    if (!state || !sourceImage || failed) return;
    var size = renderSize();
    if (els.canvas.width !== size || els.canvas.height !== size) {
      els.canvas.width = size;
      els.canvas.height = size;
    }
    display.setTransform(1, 0, 0, 1, 0, 0);
    display.clearRect(0, 0, size, size);
    var started = performance && performance.now ? performance.now() : 0;
    if (engine === "gpu" && gpu) {
      var painted = false;
      try {
        painted = gpu.draw(size, state, edge);
      } catch (e) {
        painted = false;
      }
      if (painted) {
        display.clearRect(0, 0, size, size);
        display.drawImage(gpu.canvas, 0, 0, size, size);
      } else {
        fallBackToSoftware("纹理渲染中断，已切换到软件采样");
        return;
      }
    } else {
      try {
        drawSoftware(size, state, edge);
      } catch (e) {
        fail("软件渲染无法完成", "设备内存不足或图片数据损坏");
        return;
      }
    }
    var ms =
      started && performance && performance.now
        ? performance.now() - started
        : 0;
    drawCount++;
    fpsEma = fpsEma ? fpsEma * 0.8 + ms * 0.2 : ms;
    if (!firstFrameDone) {
      firstFrameDone = true;
      els.loading.hidden = true;
      if (els.poster) els.poster.hidden = true;
    }
    updateLabels(size, fpsEma);
  }

  function schedule() {
    if (failed || frame) return;
    frame = requestAnimationFrame(draw);
  }

  function fallBackToSoftware(notice) {
    engine = "software";
    try {
      ensureSampler();
    } catch (e) {
      fail("照片数据无法读取", "浏览器不允许读取作品内的图片");
      return;
    }
    els.engine.value = "software";
    announceEngine();
    if (notice) showNotice(notice, 4200);
    schedule();
  }

  function initEngine() {
    if (!sourceImage || failed) return;
    enginePref = els.engine.value;
    var wantsGpu = enginePref === "gpu" || enginePref === "auto";
    if (wantsGpu && !gpu && hasWebGL()) {
      try {
        gpu = buildGpu(sourceImage, function () {
          gpu = null;
          fallBackToSoftware("图形上下文已丢失，已切换到软件采样");
        });
      } catch (e) {
        gpu = null;
      }
    }
    if (wantsGpu && gpu) {
      engine = "gpu";
    } else {
      if (enginePref === "gpu") {
        els.engine.value = "software";
        showNotice(
          "这台设备无法使用纹理采样，已切换到软件采样（仍可拖动探索）",
          4600,
        );
      }
      engine = "software";
      try {
        ensureSampler();
      } catch (e) {
        fail("照片数据无法读取", "浏览器不允许读取作品内的图片");
        return;
      }
    }
    firstFrameDone = false;
    drawCount = 0;
    fpsEma = 0;
    announceEngine();
    schedule();
  }

  // ---- interactions -------------------------------------------------------

  var pointers = new Map();
  var dragStart = null;
  var pinchStart = null;

  function pointerDistance() {
    var list = Array.from(pointers.values());
    return Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y);
  }

  function beginGesture() {
    interactive = true;
    var list = Array.from(pointers.values());
    if (list.length === 1) {
      dragStart = {
        x: list[0].x,
        y: list[0].y,
        yaw: state.yaw,
        pitch: state.pitch,
      };
      pinchStart = null;
    } else if (list.length === 2) {
      dragStart = null;
      pinchStart = {
        distance: Math.max(1, pointerDistance()),
        zoom: state.zoom,
      };
    }
    schedule();
  }

  function onPointerDown(event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    try {
      els.stage.setPointerCapture(event.pointerId);
    } catch (e) {}
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    beginGesture();
  }

  function onPointerMove(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size >= 2 && pinchStart) {
      var ratio = pointerDistance() / pinchStart.distance;
      setState({ zoom: clamp(pinchStart.zoom * ratio, 0.3, 3) });
    } else if (pointers.size === 1 && dragStart) {
      var extent = Math.max(1, els.stage.getBoundingClientRect().width);
      setState({
        yaw: wrap(
          dragStart.yaw + ((event.clientX - dragStart.x) / extent) * 360,
          360,
        ),
        pitch: clamp(
          dragStart.pitch + ((event.clientY - dragStart.y) / extent) * 180,
          -85,
          85,
        ),
      });
    }
  }

  function endPointer(event) {
    pointers.delete(event.pointerId);
    if (pointers.size === 1) {
      beginGesture();
    } else if (pointers.size === 0) {
      dragStart = null;
      pinchStart = null;
      interactive = false;
      schedule();
    }
  }

  function onWheel(event) {
    event.preventDefault();
    var delta = clamp(event.deltaY, -150, 150);
    setState({ zoom: clamp(state.zoom * Math.exp(-delta * 0.002), 0.3, 3) });
  }

  function onKeyDown(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    var target = event.target;
    var tag = target && target.tagName ? target.tagName : "";
    if (
      tag === "INPUT" ||
      tag === "SELECT" ||
      tag === "TEXTAREA" ||
      tag === "BUTTON" ||
      (target && target.isContentEditable)
    )
      return;
    var step = event.shiftKey ? 15 : 5;
    var handled = true;
    if (event.key === "ArrowLeft") setState({ yaw: wrap(state.yaw - step, 360) });
    else if (event.key === "ArrowRight")
      setState({ yaw: wrap(state.yaw + step, 360) });
    else if (event.key === "ArrowUp")
      setState({ pitch: clamp(state.pitch + step, -85, 85) });
    else if (event.key === "ArrowDown")
      setState({ pitch: clamp(state.pitch - step, -85, 85) });
    else if (event.key === "+" || event.key === "=")
      setState({ zoom: clamp(state.zoom * 1.08, 0.3, 3) });
    else if (event.key === "-" || event.key === "_")
      setState({ zoom: clamp(state.zoom / 1.08, 0.3, 3) });
    else if (event.key === "0") resetView();
    else if (event.key === "p" || event.key === "P")
      setState(
        { mode: state.mode === "planet" ? "tunnel" : "planet" },
        "已切换投影视角",
      );
    else handled = false;
    if (handled) event.preventDefault();
  }

  function bind() {
    els.stage.addEventListener("pointerdown", onPointerDown);
    els.stage.addEventListener("pointermove", onPointerMove);
    els.stage.addEventListener("pointerup", endPointer);
    els.stage.addEventListener("pointercancel", endPointer);
    els.stage.addEventListener("lostpointercapture", endPointer);
    els.stage.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);

    els.planet.addEventListener("click", function () {
      setState({ mode: "planet" }, "已切换到小行星视角");
    });
    els.tunnel.addEventListener("click", function () {
      setState({ mode: "tunnel" }, "已切换到时空隧道视角");
    });
    els.reset.addEventListener("click", resetView);
    els.zoomIn.addEventListener("click", function () {
      setState({ zoom: clamp(state.zoom * 1.12, 0.3, 3) });
    });
    els.zoomOut.addEventListener("click", function () {
      setState({ zoom: clamp(state.zoom / 1.12, 0.3, 3) });
    });
    els.yaw.addEventListener("input", function () {
      setState({ yaw: wrap(Number(els.yaw.value), 360) });
    });
    els.pitch.addEventListener("input", function () {
      setState({ pitch: clamp(Number(els.pitch.value), -85, 85) });
    });
    els.roll.addEventListener("input", function () {
      setState({ roll: wrap(Number(els.roll.value), 360) });
    });
    els.zoom.addEventListener("input", function () {
      setState({ zoom: clamp(Number(els.zoom.value), 0.3, 3) });
    });
    els.engine.addEventListener("change", function () {
      initEngine();
    });

    if (typeof ResizeObserver === "function") {
      new ResizeObserver(function () {
        schedule();
      }).observe(els.stage);
    } else {
      window.addEventListener("resize", schedule);
    }
  }

  function showMeta() {
    var summary =
      "作者视角 · " +
      modeName(author.mode) +
      " · 水平 " +
      Math.round(author.yaw) +
      "° · 俯仰 " +
      Math.round(author.pitch) +
      "° · 旋转 " +
      Math.round(author.roll) +
      "° · 缩放 " +
      author.zoom.toFixed(2) +
      "×";
    els.meta.textContent = summary;
    els.meta.title = summary;
  }

  function boot() {
    try {
      payload = readPayload();
      author = normalizeProjection(payload.projection);
      state = normalizeProjection(payload.projection);
      edge = normalizeEdge(payload.edge);
      enginePref =
        payload.renderer === "software" || payload.renderer === "gpu"
          ? payload.renderer
          : "auto";
      els.engine.value = enginePref;
      els.title.textContent = payload.title || "我的星球";
      // The poster stays hidden until the first painted frame or a failure,
      // so it never competes with the canvas during normal operation.
      if (typeof payload.poster === "string" && els.poster)
        els.poster.src = payload.poster;
      syncControls();
      showMeta();
      bind();

      var img = new Image();
      img.decoding = "async";
      img.onload = function () {
        if (!img.naturalWidth || !img.naturalHeight) {
          fail("作品内的照片无法解码", "尺寸为零");
          return;
        }
        sourceImage = img;
        initEngine();
      };
      img.onerror = function () {
        fail("作品内的照片无法解码", "文件可能不完整");
      };
      img.src = payload.image.dataUrl;
    } catch (e) {
      fail(e instanceof Error ? e.message : "无法打开这幅作品");
    }
  }

  boot();
})();
