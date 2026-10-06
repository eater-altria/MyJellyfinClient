// Refractive glass backing for the Lua OSC. OUTPUT is after color management and before
// mpv's target OSD overlays: icons, text and subtitles stay sharp.
// Use low-resolution separable blur; all passes are skipped without surfaces.
// Geometry uses OSD pixels mapped onto the visible video rectangle. No CPU
// screenshots, video readback, SDR clamp or independent HDR conversion.
// Parameter semantics inspired by https://github.com/rdev/liquid-glass-react:
// displacementScale=70, blurAmount=0.0625, saturation=140%, aberrationIntensity=2.
// The analytical edge lens below uses OSC geometry instead of an SVG bitmap.

//!PARAM displacement_scale
//!TYPE DYNAMIC float
//!MINIMUM 0
//!MAXIMUM 200
70

//!PARAM blur_px
//!TYPE DYNAMIC float
//!MINIMUM 0
//!MAXIMUM 32
6

//!PARAM saturation
//!TYPE DYNAMIC float
//!MINIMUM 0
//!MAXIMUM 2
1.4

//!PARAM aberration_intensity
//!TYPE DYNAMIC float
//!MINIMUM 0
//!MAXIMUM 4
2

//!PARAM surface_count
//!TYPE DYNAMIC float
0

//!PARAM video_x
//!TYPE DYNAMIC float
0

//!PARAM video_y
//!TYPE DYNAMIC float
0

//!PARAM video_w
//!TYPE DYNAMIC float
1

//!PARAM video_h
//!TYPE DYNAMIC float
1

//!PARAM ui_scale
//!TYPE DYNAMIC float
1

//!PARAM r1_x
//!TYPE DYNAMIC float
0

//!PARAM r1_y
//!TYPE DYNAMIC float
0

//!PARAM r1_w
//!TYPE DYNAMIC float
0

//!PARAM r1_h
//!TYPE DYNAMIC float
0

//!PARAM r1_radius
//!TYPE DYNAMIC float
0

//!PARAM r2_x
//!TYPE DYNAMIC float
0

//!PARAM r2_y
//!TYPE DYNAMIC float
0

//!PARAM r2_w
//!TYPE DYNAMIC float
0

//!PARAM r2_h
//!TYPE DYNAMIC float
0

//!PARAM r2_radius
//!TYPE DYNAMIC float
0

//!PARAM r3_x
//!TYPE DYNAMIC float
0

//!PARAM r3_y
//!TYPE DYNAMIC float
0

//!PARAM r3_w
//!TYPE DYNAMIC float
0

//!PARAM r3_h
//!TYPE DYNAMIC float
0

//!PARAM r3_radius
//!TYPE DYNAMIC float
0

//!PARAM r4_x
//!TYPE DYNAMIC float
0

//!PARAM r4_y
//!TYPE DYNAMIC float
0

//!PARAM r4_w
//!TYPE DYNAMIC float
0

//!PARAM r4_h
//!TYPE DYNAMIC float
0

//!PARAM r4_radius
//!TYPE DYNAMIC float
0

//!PARAM r5_x
//!TYPE DYNAMIC float
0

//!PARAM r5_y
//!TYPE DYNAMIC float
0

//!PARAM r5_w
//!TYPE DYNAMIC float
0

//!PARAM r5_h
//!TYPE DYNAMIC float
0

//!PARAM r5_radius
//!TYPE DYNAMIC float
0

//!PARAM r6_x
//!TYPE DYNAMIC float
0

//!PARAM r6_y
//!TYPE DYNAMIC float
0

//!PARAM r6_w
//!TYPE DYNAMIC float
0

//!PARAM r6_h
//!TYPE DYNAMIC float
0

//!PARAM r6_radius
//!TYPE DYNAMIC float
0

//!HOOK OUTPUT
//!BIND HOOKED
//!SAVE MJC_FROST_H
//!WIDTH HOOKED.w 4 /
//!HEIGHT HOOKED.h 4 /
//!WHEN surface_count 0 >
//!DESC MJC glass horizontal blur
vec4 hook() {
    // The optimized nine-tap kernel has sigma ~1.64 * step.
    vec2 step_uv = vec2(blur_px * 0.61 * ui_scale / video_w, 0.0);
    vec4 color = HOOKED_tex(HOOKED_pos) * 0.2270270270;
    color += HOOKED_tex(HOOKED_pos + step_uv * 1.3846153846) * 0.3162162162;
    color += HOOKED_tex(HOOKED_pos - step_uv * 1.3846153846) * 0.3162162162;
    color += HOOKED_tex(HOOKED_pos + step_uv * 3.2307692308) * 0.0702702703;
    color += HOOKED_tex(HOOKED_pos - step_uv * 3.2307692308) * 0.0702702703;
    return color;
}

//!HOOK OUTPUT
//!BIND MJC_FROST_H
//!SAVE MJC_FROST
//!WIDTH MJC_FROST_H.w
//!HEIGHT MJC_FROST_H.h
//!WHEN surface_count 0 >
//!DESC MJC glass vertical blur
vec4 hook() {
    vec2 step_uv = vec2(0.0, blur_px * 0.61 * ui_scale / video_h);
    vec4 color = MJC_FROST_H_tex(MJC_FROST_H_pos) * 0.2270270270;
    color += MJC_FROST_H_tex(MJC_FROST_H_pos + step_uv * 1.3846153846) * 0.3162162162;
    color += MJC_FROST_H_tex(MJC_FROST_H_pos - step_uv * 1.3846153846) * 0.3162162162;
    color += MJC_FROST_H_tex(MJC_FROST_H_pos + step_uv * 3.2307692308) * 0.0702702703;
    color += MJC_FROST_H_tex(MJC_FROST_H_pos - step_uv * 3.2307692308) * 0.0702702703;
    return color;
}

//!HOOK OUTPUT
//!BIND HOOKED
//!BIND MJC_FROST
//!WHEN surface_count 0 >
//!DESC MJC glass surface composite
// Resolve overlapping surfaces once: a foreground menu/panel uses its own lens,
// without accumulating displacement from the control bar behind it.
void surface_lens(vec2 p, vec4 rect, float radius, inout float mask,
                  inout vec2 offset, inout float edge) {
    if (rect.z <= 0.0 || rect.w <= 0.0) return;
    float r = min(radius, min(rect.z, rect.w) * 0.5);
    vec2 local = p - rect.xy - rect.zw * 0.5;
    if (any(greaterThan(abs(local), rect.zw * 0.5 + vec2(1.0)))) return;
    vec2 q = abs(local) - rect.zw * 0.5 + r;
    float distance = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
    float coverage = 1.0 - smoothstep(-0.75, 0.75, distance);
    if (coverage <= 0.0) return;
    vec2 outside = max(q, vec2(0.0));
    vec2 normal;
    if (dot(outside, outside) > 0.0001)
        normal = normalize(outside) * sign(local);
    else
        normal = q.x > q.y ? vec2(sign(local.x), 0.0) : vec2(0.0, sign(local.y));
    float band = min(12.0 * ui_scale, min(rect.z, rect.w) * 0.45);
    float t = clamp(-distance / max(band, 0.01), 0.0, 1.0);
    // Continuous at the rim and center; strongest lensing is inside the bevel.
    float profile = sin(t * 3.1415926536);
    float amplitude = min(displacement_scale * 0.12 * ui_scale, band * 0.8);
    offset = -normal * amplitude * profile;
    edge = 1.0 - smoothstep(0.0, 1.0, t);
    mask = max(mask, coverage);
}
vec2 bounded_uv(vec2 uv, vec2 size) {
    // Never wrap pixels across the opposite video edge during refraction.
    return clamp(uv, 0.5 / size, vec2(1.0) - 0.5 / size);
}
vec4 hook() {
    vec4 original = HOOKED_tex(HOOKED_pos);
    vec2 p = HOOKED_pos * vec2(video_w, video_h) + vec2(video_x, video_y);
    float mask = 0.0;
    vec2 offset = vec2(0.0);
    float edge = 0.0;
    surface_lens(p, vec4(r1_x, r1_y, r1_w, r1_h), r1_radius, mask, offset, edge);
    surface_lens(p, vec4(r2_x, r2_y, r2_w, r2_h), r2_radius, mask, offset, edge);
    surface_lens(p, vec4(r3_x, r3_y, r3_w, r3_h), r3_radius, mask, offset, edge);
    surface_lens(p, vec4(r4_x, r4_y, r4_w, r4_h), r4_radius, mask, offset, edge);
    surface_lens(p, vec4(r5_x, r5_y, r5_w, r5_h), r5_radius, mask, offset, edge);
    surface_lens(p, vec4(r6_x, r6_y, r6_w, r6_h), r6_radius, mask, offset, edge);
    if (mask <= 0.0) return original;
    vec2 delta = offset / vec2(video_w, video_h);
    float green_scale = 1.0 - aberration_intensity * 0.05;
    float blue_scale = 1.0 - aberration_intensity * 0.10;
    vec3 sharp = vec3(
        HOOKED_tex(bounded_uv(HOOKED_pos + delta, HOOKED_size)).r,
        HOOKED_tex(bounded_uv(HOOKED_pos + delta * green_scale, HOOKED_size)).g,
        HOOKED_tex(bounded_uv(HOOKED_pos + delta * blue_scale, HOOKED_size)).b);
    vec3 soft = vec3(
        MJC_FROST_tex(bounded_uv(MJC_FROST_pos + delta, MJC_FROST_size)).r,
        MJC_FROST_tex(bounded_uv(MJC_FROST_pos + delta * green_scale, MJC_FROST_size)).g,
        MJC_FROST_tex(bounded_uv(MJC_FROST_pos + delta * blue_scale, MJC_FROST_size)).b);
    vec3 glass = mix(soft, sharp, 0.18 + edge * 0.68);
    float luma = dot(glass, vec3(0.2126, 0.7152, 0.0722));
    glass = mix(vec3(luma), glass, saturation);
    // Reference overLight behavior: add contrast on bright SDR backgrounds.
    // PQ/HLG/linear outputs arrive with saturation=1 and keep their HDR range.
    if (saturation > 1.001)
        glass *= 1.0 - 0.30 * smoothstep(0.55, 0.90, luma);
    return mix(original, vec4(glass, original.a), mask);
}
