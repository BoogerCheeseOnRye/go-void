/* Minimal WebGL2 utilities: programs, meshes and render targets. */

export function createGL(canvas) {
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: true,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  return gl;
}

function shaderSourceWithLines(source) {
  return source
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(3, ' ')}: ${line}`)
    .join('\n');
}

export function compileShader(gl, type, source, label = 'shader') {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`could not create ${label}`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || 'unknown compile error';
    gl.deleteShader(shader);
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    throw new Error(`${label} (${kind}) compile failed:\n${log}\n\n${shaderSourceWithLines(source)}`);
  }
  return shader;
}

export class Program {
  constructor(gl, vertexSource, fragmentSource, label = 'program') {
    this.gl = gl;
    this.label = label;
    const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource, label);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, label);
    const program = gl.createProgram();
    if (!program) throw new Error(`could not create ${label}`);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) || 'unknown link error';
      gl.deleteProgram(program);
      throw new Error(`${label} link failed:\n${log}`);
    }
    this.program = program;
    this.uniforms = new Map();
    this.attribs = new Map();
  }

  use() {
    this.gl.useProgram(this.program);
    return this;
  }

  u(name) {
    if (!this.uniforms.has(name)) {
      this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));
    }
    return this.uniforms.get(name);
  }

  a(name) {
    if (!this.attribs.has(name)) {
      this.attribs.set(name, this.gl.getAttribLocation(this.program, name));
    }
    return this.attribs.get(name);
  }

  setInt(name, value) {
    const loc = this.u(name);
    if (loc) this.gl.uniform1i(loc, value);
    return this;
  }

  setFloat(name, value) {
    const loc = this.u(name);
    if (loc) this.gl.uniform1f(loc, value);
    return this;
  }

  setVec2(name, x, y) {
    const loc = this.u(name);
    if (loc) this.gl.uniform2f(loc, x, y);
    return this;
  }

  setVec3(name, x, y, z) {
    const loc = this.u(name);
    if (loc) this.gl.uniform3f(loc, x, y, z);
    return this;
  }

  setVec4(name, x, y, z, w) {
    const loc = this.u(name);
    if (loc) this.gl.uniform4f(loc, x, y, z, w);
    return this;
  }

  setMat4(name, mat) {
    const loc = this.u(name);
    if (loc) this.gl.uniformMatrix4fv(loc, false, mat);
    return this;
  }

  setFloatArray(name, arr) {
    const loc = this.u(name);
    if (loc) this.gl.uniform1fv(loc, arr);
    return this;
  }

  setVec2Array(name, arr) {
    const loc = this.u(name);
    if (loc) this.gl.uniform2fv(loc, arr);
    return this;
  }

  dispose() {
    this.gl.deleteProgram(this.program);
    this.uniforms.clear();
    this.attribs.clear();
  }
}

export function bufferData(gl, target, data, usage = gl.STATIC_DRAW) {
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error('could not create buffer');
  gl.bindBuffer(target, buffer);
  gl.bufferData(target, data, usage);
  return buffer;
}

export function createMesh(gl, { positions, normals, uvs, indices, dynamic = false }) {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error('could not create VAO');
  gl.bindVertexArray(vao);

  const usage = dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW;
  const pos = bufferData(gl, gl.ARRAY_BUFFER, positions, usage);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

  let nrm = null;
  if (normals) {
    nrm = bufferData(gl, gl.ARRAY_BUFFER, normals, usage);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
  }

  let uv = null;
  if (uvs) {
    uv = bufferData(gl, gl.ARRAY_BUFFER, uvs, usage);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
  }

  let ibo = null;
  if (indices) {
    ibo = bufferData(gl, gl.ELEMENT_ARRAY_BUFFER, indices, usage);
  }

  gl.bindVertexArray(null);
  const count = indices ? indices.length : positions.length / 3;
  return { vao, buffers: { positions: pos, normals: nrm, uvs: uv, indices: ibo }, count, indexed: Boolean(indices) };
}

export function drawMesh(gl, mesh, mode = gl.TRIANGLES) {
  gl.bindVertexArray(mesh.vao);
  if (mesh.indexed) {
    gl.drawElements(mode, mesh.count, gl.UNSIGNED_INT, 0);
  } else {
    gl.drawArrays(mode, 0, mesh.count);
  }
  gl.bindVertexArray(null);
}

export function createRenderTarget(gl, width, height, { hdr = false, depth = false, filter = gl.LINEAR } = {}) {
  const fbo = gl.createFramebuffer();
  const texture = gl.createTexture();
  if (!fbo || !texture) throw new Error('could not create render target');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  const internal = hdr ? gl.RGBA16F : gl.RGBA8;
  const type = hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, gl.RGBA, type, null);

  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

  let depthBuffer = null;
  if (depth) {
    depthBuffer = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuffer);
  }

  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    throw new Error(`render target incomplete: 0x${status.toString(16)}`);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  return { fbo, texture, depth: depthBuffer, width, height, hdr };
}

export function resizeRenderTarget(gl, target, width, height) {
  if (target.width === width && target.height === height) return target;
  deleteRenderTarget(gl, target);
  return createRenderTarget(gl, width, height, { hdr: target.hdr, depth: Boolean(target.depth) });
}

export function deleteRenderTarget(gl, target) {
  if (!target) return;
  if (target.fbo) gl.deleteFramebuffer(target.fbo);
  if (target.texture) gl.deleteTexture(target.texture);
  if (target.depth) gl.deleteRenderbuffer(target.depth);
}

export function createFullscreenQuad(gl) {
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  if (!vao || !buffer) throw new Error('could not create fullscreen quad');
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { vao, buffer };
}

export function drawFullscreen(gl, quad) {
  gl.bindVertexArray(quad.vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
}

export function bindTexture(gl, unit, texture) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
}

export function glError(gl, label = '') {
  const err = gl.getError();
  if (err !== gl.NO_ERROR) {
    throw new Error(`${label || 'WebGL'} error 0x${err.toString(16)}`);
  }
}
