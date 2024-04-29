/** 
 * LittleJS WebGL Interface
 * - All webgl used by the engine is wrapped up here
 * - For normal stuff you won't need to see or call anything in this file
 * - For advanced stuff there are helper functions to create shaders, textures, etc
 * - Can be disabled with glEnable to revert to 2D canvas rendering
 * - Batches sprite rendering on GPU for incredibly fast performance
 * - Sprite transform math is done in the shader where possible
 * - Supports shadertoy style post processing shaders
 * @namespace WebGL
 */

'use strict';

/** The WebGL canvas which appears above the main canvas and below the overlay canvas
 *  @type {HTMLCanvasElement}
 *  @memberof WebGL */
let glCanvas;

/** 2d context for glCanvas 
 *  @type {WebGLRenderingContext}
 *  @memberof WebGL */
let glContext;

// WebGL internal variables not exposed to documentation
let glActiveTexture, glShader, glArrayBuffer, glPositionData, glColorData, glBatchCount, glBatchAdditive, glAdditive;

///////////////////////////////////////////////////////////////////////////////

// Initalize WebGL, called automatically by the engine
function glInit()
{
    // create the canvas and textures
    glCanvas = document.createElement('canvas');
    glContext = glCanvas.getContext('webgl2');

    // some browsers are much faster without copying the gl buffer so we just overlay it instead
    glOverlay && document.body.appendChild(glCanvas);

    // setup vertex and fragment shaders
    glShader = glCreateProgram(
        '#version 300 es\n' +         // specify GLSL ES version
        'precision highp float;'+     // use highp for better accuracy
        'uniform mat4 m;'+            // transform matrix
        'in vec4 p,c,a;'+             // position, uv, color, additiveColor
        'out vec4 v,d,e;'+            // return uv, color, additiveColor
        'void main(){'+               // shader entry point
        'gl_Position=m*vec4(p.xy,1,1);'+ // transform position
        'v=p;d=c;e=a;'+               // pass stuff to fragment shader
        '}'                           // end of shader
        ,
        '#version 300 es\n' +         // specify GLSL ES version
        'precision highp float;'+     // use highp for better accuracy
        'in vec4 v,d,e;'+             // position, uv, color, additiveColor
        'uniform sampler2D s;'+       // texture
        'out vec4 c;'+                // out color
        'void main(){'+               // shader entry point
        'c=texture(s,v.zw)*d+e;'+     // modulate texture by color plus additive
        '}'                           // end of shader
    );

    // init buffers
    const vertexData = new ArrayBuffer(gl_VERTEX_BUFFER_SIZE);
    glArrayBuffer = glContext.createBuffer();
    glPositionData = new Float32Array(vertexData);
    glColorData = new Uint32Array(vertexData);
    glBatchCount = 0;
}

// Setup render each frame, called automatically by engine
function glPreRender()
{
    // clear and set to same size as main canvas
    glContext.viewport(0, 0, glCanvas.width = mainCanvas.width, glCanvas.height = mainCanvas.height);
    glContext.clear(gl_COLOR_BUFFER_BIT);

    // set up the shader
    glContext.useProgram(glShader);
    glContext.activeTexture(gl_TEXTURE0);
    glContext.bindTexture(gl_TEXTURE_2D, glActiveTexture = textureInfos[0].glTexture);
    glContext.bindBuffer(gl_ARRAY_BUFFER, glArrayBuffer);
    glContext.bufferData(gl_ARRAY_BUFFER, gl_VERTEX_BUFFER_SIZE, gl_DYNAMIC_DRAW);
    glSetBlendMode();
    
    // set vertex attributes
    let offset = 0;
    const initVertexAttribArray = (name, type, typeSize, size, normalize=0)=>
    {
        const location = glContext.getAttribLocation(glShader, name);
        glContext.enableVertexAttribArray(location);
        glContext.vertexAttribPointer(location, size, type, normalize, gl_VERTEX_BYTE_STRIDE, offset);
        offset += size*typeSize;
    }
    initVertexAttribArray('p', gl_FLOAT, 4, 4);            // position & texture coords
    initVertexAttribArray('c', gl_UNSIGNED_BYTE, 1, 4, 1); // color
    initVertexAttribArray('a', gl_UNSIGNED_BYTE, 1, 4, 1); // additiveColor

    // build the transform matrix
    const sx = 2 * cameraScale / mainCanvas.width;
    const sy = 2 * cameraScale / mainCanvas.height;
    glContext.uniformMatrix4fv(glContext.getUniformLocation(glShader, 'm'), 0,
        new Float32Array([
            sx, 0, 0, 0,
            0, sy, 0, 0,
            1, 1, -1, 1,
            -1-sx*cameraPos.x, -1-sy*cameraPos.y, 0, 0
        ])
    );
}

/** Set the WebGl blend mode, normally you should call setBlendMode instead
 *  @param {Boolean} [additive=0]
 *  @memberof WebGL */
function glSetBlendMode(additive=0)
{
    // setup blending
    glAdditive = additive;
}

/** Set the WebGl texture, called automatically if using multiple textures
 *  - This may also flush the gl buffer resulting in more draw calls and worse performance
 *  @param {WebGLTexture} texture
 *  @memberof WebGL */
function glSetTexture(texture)
{
    // must flush cache with the old texture to set a new one
    if (texture == glActiveTexture)
        return;

    glFlush();
    glContext.bindTexture(gl_TEXTURE_2D, glActiveTexture = texture);
}

/** Compile WebGL shader of the given type, will throw errors if in debug mode
 *  @param {String} source
 *  @param          type
 *  @return {WebGLShader}
 *  @memberof WebGL */
function glCompileShader(source, type)
{
    // build the shader
    const shader = glContext.createShader(type);
    glContext.shaderSource(shader, source);
    glContext.compileShader(shader);

    // check for errors
    if (debug && !glContext.getShaderParameter(shader, gl_COMPILE_STATUS))
        throw glContext.getShaderInfoLog(shader);
    return shader;
}

/** Create WebGL program with given shaders
 *  @param {WebGLShader} vsSource
 *  @param {WebGLShader} fsSource
 *  @return {WebGLProgram}
 *  @memberof WebGL */
function glCreateProgram(vsSource, fsSource)
{
    // build the program
    const program = glContext.createProgram();
    glContext.attachShader(program, glCompileShader(vsSource, gl_VERTEX_SHADER));
    glContext.attachShader(program, glCompileShader(fsSource, gl_FRAGMENT_SHADER));
    glContext.linkProgram(program);

    // check for errors
    if (debug && !glContext.getProgramParameter(program, gl_LINK_STATUS))
        throw glContext.getProgramInfoLog(program);
    return program;
}

/** Create WebGL texture from an image and set the texture settings
 *  @param {Image} image
 *  @return {WebGLTexture}
 *  @memberof WebGL */
function glCreateTexture(image)
{
    // build the texture
    const texture = glContext.createTexture();
    glContext.bindTexture(gl_TEXTURE_2D, texture);
    image && image.width && glContext.texImage2D(gl_TEXTURE_2D, 0, gl_RGBA, gl_RGBA, gl_UNSIGNED_BYTE, image);
        
    // use point filtering for pixelated rendering
    const filter = canvasPixelated ? gl_NEAREST : gl_LINEAR;
    glContext.texParameteri(gl_TEXTURE_2D, gl_TEXTURE_MIN_FILTER, filter);
    glContext.texParameteri(gl_TEXTURE_2D, gl_TEXTURE_MAG_FILTER, filter);
    glContext.texParameteri(gl_TEXTURE_2D, gl_TEXTURE_WRAP_S, gl_CLAMP_TO_EDGE);
    glContext.texParameteri(gl_TEXTURE_2D, gl_TEXTURE_WRAP_T, gl_CLAMP_TO_EDGE);
    return texture;
}

/** Draw all sprites and clear out the buffer, called automatically by the system whenever necessary
 *  @memberof WebGL */
function glFlush()
{
    if (!glBatchCount) return;

    const destBlend = glBatchAdditive ? gl_ONE : gl_ONE_MINUS_SRC_ALPHA;
    glContext.blendFuncSeparate(gl_SRC_ALPHA, destBlend, gl_ONE, destBlend);
    glContext.enable(gl_BLEND);

    // draw all the sprites in the batch and reset the buffer
    glContext.bufferSubData(gl_ARRAY_BUFFER, 0, 
        glPositionData.subarray(0, glBatchCount * gl_INDICIES_PER_VERT));
    glContext.drawArrays(gl_TRIANGLE_STRIP, 0, glBatchCount);
    glBatchCount = 0;
    glBatchAdditive = glAdditive;
}

/** Draw any sprites still in the buffer, copy to main canvas and clear
 *  @param {CanvasRenderingContext2D} context
 *  @param {Boolean} [forceDraw=0]
 *  @memberof WebGL */
function glCopyToContext(context, forceDraw)
{
    if (!glBatchCount && !forceDraw) return;
    
    glFlush();
    
    // do not draw in overlay mode because the canvas is visible
    if (!glOverlay || forceDraw)
        context.drawImage(glCanvas, 0, 0);
}

/** Add a sprite to the gl draw list, used by all gl draw functions
 *  @param {Number} x
 *  @param {Number} y
 *  @param {Number} sizeX
 *  @param {Number} sizeY
 *  @param {Number} angle
 *  @param {Number} uv0X
 *  @param {Number} uv0Y
 *  @param {Number} uv1X
 *  @param {Number} uv1Y
 *  @param {Number} rgba
 *  @param {Number} [rgbaAdditive=0]
 *  @memberof WebGL */
function glDraw(x, y, sizeX, sizeY, angle, uv0X, uv0Y, uv1X, uv1Y, rgba, rgbaAdditive=0)
{
    // flush if there is not enough room or if different blend mode
    const vertCount = 6;
    if (glBatchCount >= gl_MAX_BATCH-vertCount || glBatchAdditive != glAdditive)
        glFlush();

    // prepare to create the verts from size and angle
    const c = Math.cos(angle)/2, s = Math.sin(angle)/2;
    const cx = c*sizeX, cy = c*sizeY, sx = s*sizeX, sy = s*sizeY;
    const positionData = 
    [
        x-cx+sy, y+cy+sx, uv0X, uv0Y,
        x-cx-sy, y-cy+sx, uv0X, uv1Y,
        x+cx+sy, y+cy-sx, uv1X, uv0Y,
        x+cx-sy, y-cy-sx, uv1X, uv1Y,
    ];

    // setup 2 triangle strip quad
    for(let i = vertCount, offset = glBatchCount * gl_INDICIES_PER_VERT; i--;)
    {
        let j = clamp(i-1, 0, 3)*4;  // degenerate tri at ends
        glPositionData[offset++] = positionData[j++];
        glPositionData[offset++] = positionData[j++];
        glPositionData[offset++] = positionData[j++];
        glPositionData[offset++] = positionData[j++];
        glColorData[offset++] = rgba; 
        glColorData[offset++] = rgbaAdditive;
    }
    glBatchCount += vertCount;
}

/** Add a convex polygon to the gl draw list
 *  @param {Array} points - Array of Vector2 points
 *  @param {Number} rgba - Color of the polygon
 *  @memberof WebGL */
function glDrawPoints(points, rgba)
{
    // flush if there is not enough room or if different blend mode
    const vertCount = points.length + 2;
    if (glBatchCount >= gl_MAX_BATCH-vertCount || glBatchAdditive != glAdditive)
        glFlush();
  
    // setup triangle strip from list of points
    for(let i = vertCount, offset = glBatchCount * gl_INDICIES_PER_VERT; i--;)
    {
        const j = clamp(i-1, 0, vertCount-3);  // degenerate tri at ends
        const h = j>>1;
        const point = points[j%2? h : vertCount-3-h];
        glPositionData[offset++] = point.x;
        glPositionData[offset++] = point.y;
        glPositionData[offset++] = 0; // uvx
        glPositionData[offset++] = 0; // uvy
        glColorData[offset++] = 0;    // nothing to tint
        glColorData[offset++] = rgba; // apply rgba via additive
    }
    glBatchCount += vertCount;
}

///////////////////////////////////////////////////////////////////////////////
// post processing - can be enabled to pass other canvases through a final shader

let glPostShader, glPostArrayBuffer, glPostTexture, glPostIncludeOverlay;

/** Set up a post processing shader
 *  @param {String} shaderCode
 *  @param {Boolean} includeOverlay
 *  @memberof WebGL */
function glInitPostProcess(shaderCode, includeOverlay)
{
    ASSERT(!glPostShader); // can only have 1 post effects shader

    if (!shaderCode) // default shader pass through
        shaderCode = 'void mainImage(out vec4 c,vec2 p){c=texture(iChannel0,p/iResolution.xy);}';

    // create the shader
    glPostShader = glCreateProgram(
        '#version 300 es\n' +            // specify GLSL ES version
        'precision highp float;'+        // use highp for better accuracy
        'in vec2 p;'+                    // position
        'void main(){'+                  // shader entry point
        'gl_Position=vec4(p,1,1);'+      // set position
        '}'                              // end of shader
        ,
        '#version 300 es\n' +            // specify GLSL ES version
        'precision highp float;'+        // use highp for better accuracy
        'uniform sampler2D iChannel0;'+  // input texture
        'uniform vec3 iResolution;'+     // size of output texture
        'uniform float iTime;'+          // time passed
        'out vec4 c;'+                   // out color
        '\n' + shaderCode + '\n'+        // insert custom shader code
        'void main(){'+                  // shader entry point
        'mainImage(c,gl_FragCoord.xy);'+ // call post process function
        'c.a=1.;'+                       // always use full alpha
        '}'                              // end of shader
    );

    // create buffer and texture
    glPostArrayBuffer = glContext.createBuffer();
    glPostTexture = glCreateTexture();
    glPostIncludeOverlay = includeOverlay;

    // hide the original 2d canvas
    mainCanvas.style.visibility = 'hidden';
}

// Render the post processing shader, called automatically by the engine
function glRenderPostProcess()
{
    if (!glPostShader)
        return;
    
    // prepare to render post process shader
    if (glEnable)
    {
        glFlush(); // clear out the buffer
        mainContext.drawImage(glCanvas, 0, 0); // copy to the main canvas
    }
    else // set viewport
        glContext.viewport(0, 0, glCanvas.width = mainCanvas.width, glCanvas.height = mainCanvas.height);

    if (glPostIncludeOverlay)
    {
        // copy overlay canvas so it will be included in post processing
        mainContext.drawImage(overlayCanvas, 0, 0);

        // clear overlay canvas
        overlayCanvas.width = mainCanvas.width;
    }

    // setup shader program to draw one triangle
    glContext.useProgram(glPostShader);
    glContext.disable(gl_BLEND);
    glContext.bindBuffer(gl_ARRAY_BUFFER, glPostArrayBuffer);
    glContext.bufferData(gl_ARRAY_BUFFER, new Float32Array([-3,1,1,-3,1,1]), gl_STATIC_DRAW);
    glContext.pixelStorei(gl_UNPACK_FLIP_Y_WEBGL, true);

    // set textures, pass in the 2d canvas and gl canvas in separate texture channels
    glContext.activeTexture(gl_TEXTURE0);
    glContext.bindTexture(gl_TEXTURE_2D, glPostTexture);
    glContext.texImage2D(gl_TEXTURE_2D, 0, gl_RGBA, gl_RGBA, gl_UNSIGNED_BYTE, mainCanvas);

    // set vertex position attribute
    const vertexByteStride = 8;
    const pLocation = glContext.getAttribLocation(glPostShader, 'p');
    glContext.enableVertexAttribArray(pLocation);
    glContext.vertexAttribPointer(pLocation, 2, gl_FLOAT, 0, vertexByteStride, 0);

    // set uniforms and draw
    const uniformLocation = (name)=>glContext.getUniformLocation(glPostShader, name);
    glContext.uniform1i(uniformLocation('iChannel0'), 0);
    glContext.uniform1f(uniformLocation('iTime'), time);
    glContext.uniform3f(uniformLocation('iResolution'), mainCanvas.width, mainCanvas.height, 1);
    glContext.drawArrays(gl_TRIANGLE_STRIP, 0, 3);
}

///////////////////////////////////////////////////////////////////////////////
// store gl constants as integers so their name doesn't use space in minifed
const 
gl_ONE = 1,
gl_TRIANGLE_STRIP = 5,
gl_SRC_ALPHA = 770,
gl_ONE_MINUS_SRC_ALPHA = 771,
gl_BLEND = 3042,
gl_TEXTURE_2D = 3553,
gl_UNSIGNED_BYTE = 5121,
gl_FLOAT = 5126,
gl_RGBA = 6408,
gl_NEAREST = 9728,
gl_LINEAR = 9729,
gl_TEXTURE_MAG_FILTER = 10240,
gl_TEXTURE_MIN_FILTER = 10241,
gl_TEXTURE_WRAP_S = 10242,
gl_TEXTURE_WRAP_T = 10243,
gl_COLOR_BUFFER_BIT = 16384,
gl_CLAMP_TO_EDGE = 33071,
gl_TEXTURE0 = 33984,
gl_ARRAY_BUFFER = 34962,
gl_STATIC_DRAW = 35044,
gl_DYNAMIC_DRAW = 35048,
gl_FRAGMENT_SHADER = 35632, 
gl_VERTEX_SHADER = 35633,
gl_COMPILE_STATUS = 35713,
gl_LINK_STATUS = 35714,
gl_UNPACK_FLIP_Y_WEBGL = 37440,

// constants for batch rendering
gl_INDICIES_PER_VERT = 6,
gl_MAX_BATCH = 1e5,
gl_VERTEX_BYTE_STRIDE = (4 * 2) * 2 + (4) * 2, // vec2 * 2 + (char * 4) * 2
gl_VERTEX_BUFFER_SIZE = gl_MAX_BATCH * gl_VERTEX_BYTE_STRIDE;