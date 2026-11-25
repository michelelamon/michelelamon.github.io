(function () {
  "use strict";

  var cards = document.querySelectorAll(".profile-card[data-depth]");
  if (!cards.length) return;

  var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reducedMotion) return;

  var VERT_SRC = [
    "attribute vec2 aPos;",
    "varying vec2 vUv;",
    "void main() {",
    "  vUv = aPos * 0.5 + 0.5;",
    "  gl_Position = vec4(aPos, 0.0, 1.0);",
    "}"
  ].join("\n");

  var FRAG_SRC = [
    "precision mediump float;",
    "uniform sampler2D uColor;",
    "uniform sampler2D uDepth;",
    "uniform vec2 uOffset;",
    "uniform float uStrength;",
    "uniform float uFocus;",
    "varying vec2 vUv;",
    "",
    "void main() {",
    "  vec2 baseUv = (vUv - 0.5) / 1.04 + 0.5;",
    "  vec2 dir = uOffset * uStrength;",
    "  const int STEPS = 16;",
    "  float stepSize = 1.0 / float(STEPS);",
    "  float currentLayer = 1.0;",
    "  vec2 currentUv = baseUv - dir * (1.0 - uFocus);",
    "  vec2 deltaUv = dir * stepSize;",
    "  vec2 finalUv = baseUv;",
    "",
    "  for (int i = 0; i <= STEPS; i++) {",
    "    float d = texture2D(uDepth, clamp(currentUv, 0.0, 1.0)).r;",
    "    if (d >= currentLayer) {",
    "      if (i == 0) {",
    "        finalUv = currentUv;",
    "      } else {",
    "        vec2 prevUv = currentUv - deltaUv;",
    "        float prevLayer = currentLayer + stepSize;",
    "        float prevD = texture2D(uDepth, clamp(prevUv, 0.0, 1.0)).r;",
    "        float afterDiff = d - currentLayer;",
    "        float beforeDiff = prevLayer - prevD;",
    "        float weight = afterDiff / max(afterDiff + beforeDiff, 0.0001);",
    "        finalUv = mix(currentUv, prevUv, clamp(weight, 0.0, 1.0));",
    "      }",
    "      break;",
    "    }",
    "    currentLayer -= stepSize;",
    "    currentUv += deltaUv;",
    "    finalUv = currentUv;",
    "  }",
    "",
    "  gl_FragColor = texture2D(uColor, clamp(finalUv, 0.001, 0.999));",
    "}"
  ].join("\n");

  function clamp(val, min, max) {
    return val < min ? min : val > max ? max : val;
  }

  function compileShader(gl, type, source) {
    var shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function createTexture(gl, image) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    return tex;
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = reject;
      img.src = src;
    });
  }

  function initCard(card) {
    var imgEl = card.querySelector(".profile-card-img");
    var canvas = card.querySelector(".profile-card-canvas");
    var glare = card.querySelector(".profile-card-glare");
    var gyroBtn = card.querySelector(".profile-gyro-btn");
    var depthSrc = card.getAttribute("data-depth");
    if (!imgEl || !canvas || !depthSrc) return;

    var gl = canvas.getContext("webgl", { alpha: false, antialias: true, powerPreference: "low-power" }) ||
             canvas.getContext("experimental-webgl", { alpha: false, antialias: true });
    if (!gl) return;

    var vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    var fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) return;

    var program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;

    gl.useProgram(program);

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    var aPos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    var uColor = gl.getUniformLocation(program, "uColor");
    var uDepth = gl.getUniformLocation(program, "uDepth");
    var uOffset = gl.getUniformLocation(program, "uOffset");
    var uStrength = gl.getUniformLocation(program, "uStrength");
    var uFocus = gl.getUniformLocation(program, "uFocus");

    gl.uniform1i(uColor, 0);
    gl.uniform1i(uDepth, 1);
    gl.uniform1f(uStrength, 0.026);
    gl.uniform1f(uFocus, 0.55);

    var colorTex = null;
    var depthTex = null;
    var ready = false;

    var targetX = 0;
    var targetY = 0;
    var currentX = 0;
    var currentY = 0;
    var rafId = 0;

    function resizeCanvas() {
      var rect = card.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var w = Math.round(rect.width * dpr);
      var h = Math.round(rect.height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
    }

    function draw() {
      if (!ready) return;
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, colorTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, depthTex);
      gl.uniform2f(uOffset, currentX, currentY);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      var tiltX = (-currentY * 6).toFixed(2);
      var tiltY = (currentX * 6).toFixed(2);
      card.style.transform = "perspective(700px) rotateX(" + tiltX + "deg) rotateY(" + tiltY + "deg)";

      if (glare) {
        var gx = (50 + currentX * 35).toFixed(1);
        var gy = (50 + currentY * 35).toFixed(1);
        var mag = Math.min(1, Math.hypot(currentX, currentY));
        glare.style.background =
          "radial-gradient(circle at " + gx + "% " + gy + "%, rgba(255,255,255,0.22), rgba(255,255,255,0) 62%)";
        glare.style.opacity = (mag * 0.85).toFixed(3);
      }
    }

    function tick() {
      rafId = 0;
      var dx = targetX - currentX;
      var dy = targetY - currentY;

      if (Math.abs(dx) < 0.0005 && Math.abs(dy) < 0.0005) {
        currentX = targetX;
        currentY = targetY;
        draw();
        return;
      }

      currentX += dx * 0.12;
      currentY += dy * 0.12;
      draw();
      rafId = window.requestAnimationFrame(tick);
    }

    function wake() {
      if (!ready) return;
      if (!rafId) {
        rafId = window.requestAnimationFrame(tick);
      }
    }

    function setTarget(nx, ny) {
      targetX = clamp(nx, -1, 1);
      targetY = clamp(ny, -1, 1);
      wake();
    }

    // Symmetric proximity mouse tracking around the card (all directions)
    window.addEventListener("pointermove", function (e) {
      if (e.pointerType !== "mouse") return;
      var rect = card.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      var cx = rect.left + rect.width * 0.5;
      var cy = rect.top + rect.height * 0.5;
      var cardSize = Math.max(rect.width, rect.height);
      var activeRadius = cardSize * 0.9;
      var outerRadius = cardSize * 1.85;
      var dx = e.clientX - cx;
      var dy = e.clientY - cy;
      var dist = Math.hypot(dx, dy);

      if (dist >= outerRadius || dist === 0) {
        setTarget(0, 0);
        return;
      }

      var strength = Math.min(1, dist / activeRadius);
      if (dist > activeRadius) {
        var t = (outerRadius - dist) / (outerRadius - activeRadius);
        strength *= t * t * (3 - 2 * t);
      }
      setTarget((dx / dist) * strength, (dy / dist) * strength);
    }, { passive: true });

    document.documentElement.addEventListener("pointerleave", function () {
      setTarget(0, 0);
    }, { passive: true });

    window.addEventListener("blur", function () {
      setTarget(0, 0);
    }, { passive: true });

    // Passive touch-drag fallback on the card itself
    card.addEventListener("pointermove", function (e) {
      if (e.pointerType !== "touch") return;
      var cardRect = card.getBoundingClientRect();
      if (!cardRect.width || !cardRect.height) return;
      var nx = ((e.clientX - cardRect.left) / cardRect.width) * 2 - 1;
      var ny = ((e.clientY - cardRect.top) / cardRect.height) * 2 - 1;
      setTarget(nx, ny);
    }, { passive: true });

    // Mobile gyroscope support with neutral holding-angle calibration
    var gyroActive = false;
    var baseBeta = null;
    var baseGamma = null;

    function getScreenAngle() {
      if (window.screen && window.screen.orientation && typeof window.screen.orientation.angle === "number") {
        return window.screen.orientation.angle;
      }
      return typeof window.orientation === "number" ? window.orientation : 0;
    }

    function onOrientation(e) {
      if (typeof e.beta !== "number" || typeof e.gamma !== "number") return;
      if (baseBeta === null || baseGamma === null) {
        baseBeta = e.beta;
        baseGamma = e.gamma;
      }

      var dBeta = e.beta - baseBeta;
      var dGamma = e.gamma - baseGamma;
      var angle = getScreenAngle();
      var xDeg = dGamma;
      var yDeg = dBeta;

      if (angle === 90) {
        xDeg = -dBeta;
        yDeg = dGamma;
      } else if (angle === -90 || angle === 270) {
        xDeg = dBeta;
        yDeg = -dGamma;
      } else if (angle === 180) {
        xDeg = -dGamma;
        yDeg = -dBeta;
      }

      // Gently re-center baseline slightly over time if held steadily
      baseBeta += dBeta * 0.004;
      baseGamma += dGamma * 0.004;

      setTarget(xDeg / 24, yDeg / 24);
    }

    function attachGyro() {
      if (gyroActive) return;
      gyroActive = true;
      baseBeta = null;
      baseGamma = null;
      window.addEventListener("deviceorientation", onOrientation, { passive: true });
      if (gyroBtn) {
        gyroBtn.hidden = true;
      }
    }

    var isTouchDevice = ("ontouchstart" in window || navigator.maxTouchPoints > 0);
    var isFinePointerOnly = window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches;

    if (isTouchDevice && !isFinePointerOnly && typeof window.DeviceOrientationEvent !== "undefined") {
      if (typeof window.DeviceOrientationEvent.requestPermission === "function") {
        // iOS 13+ requires user gesture
        if (gyroBtn) {
          gyroBtn.hidden = false;
          var requestGyro = function () {
            window.DeviceOrientationEvent.requestPermission()
              .then(function (state) {
                if (state === "granted") {
                  attachGyro();
                } else {
                  gyroBtn.hidden = true;
                }
              })
              .catch(function () {
                gyroBtn.hidden = true;
              });
          };
          gyroBtn.addEventListener("click", function (ev) {
            ev.stopPropagation();
            requestGyro();
          });
          card.addEventListener("click", function () {
            if (!gyroActive) requestGyro();
          }, { once: true });
        }
      } else {
        // Android and browsers that allow DeviceOrientation without explicit prompt
        attachGyro();
      }
    }

    Promise.all([loadImage(imgEl.currentSrc || imgEl.src), loadImage(depthSrc)])
      .then(function (images) {
        colorTex = createTexture(gl, images[0]);
        depthTex = createTexture(gl, images[1]);
        resizeCanvas();
        ready = true;
        draw();
        canvas.classList.add("is-ready");
      })
      .catch(function () {
        // Leave static <img> fallback visible
      });

    if (typeof window.ResizeObserver === "function") {
      var ro = new window.ResizeObserver(function () {
        resizeCanvas();
        draw();
      });
      ro.observe(card);
    } else {
      window.addEventListener("resize", function () {
        resizeCanvas();
        draw();
      }, { passive: true });
    }
  }

  for (var i = 0; i < cards.length; i++) {
    initCard(cards[i]);
  }
})();
