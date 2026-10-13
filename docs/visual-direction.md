# Driver-view visual direction

Updated 2026-10-11. This is an art-direction note from the user's F1-game reference and our halo-camera captures, not a request to copy a particular circuit or brand.

## What is missing

The largest gap is composition at driving height: convincing foreground, middle distance and background, rather than detail scattered around a map.

1. **Cockpit construction and framing.** The reference shows a recessed cockpit, wheel, hands, padding and overlapping body components. Our large helmet and clean surfaces hide much of this. Judge geometry and camera together; preserve a clear view of the road.
2. **Architecture framing the circuit.** Substantial grandstands, pit buildings, fencing and an overhead structure form a corridor. Our isolated buildings and low walls leave too much empty horizon. Compose a few convincing stretches; retain open sections elsewhere.
3. **Asphalt at different distances.** Tiny aggregate should be perceptible nearby and merge into broader rubber, resurfacing, streaks and lighting farther away. Avoid uniform high-contrast grain or repeated transverse tiles. Keep the dark asphalt character the user likes.
4. **Distinct material responses.** Paint, rubber, carbon, glazing and metal need different roughness, reflection and subtle surface detail. More random noise is not a substitute.
5. **Scale and construction layers.** Barrier bases and joints, posts, fence mesh, roof thickness, markings, runoff transitions and properly supported signs establish a built, used circuit.
6. **Readable shadows.** Preserve the warm, low-sun mood, but keep shaded road, tyres and cockpit legible. Inspect a clean render as well as the accepted 90s TV treatment.

## Implementation priorities

- Establish the Croft Bay main straight as the benchmark before extending the treatment around the circuit.
- Spend detail on surfaces and silhouettes visible from halo camera while approaching and passing.
- Keep the original tall skyscrapers. Use them as background depth rather than substitutes for nearby architecture.
- Keep trees near walls, varied and branching; additional tree density is not the main answer to an empty straight.
- Batch static geometry by material, cull in short sections, use textures for distant crowd/fence detail, and measure fixed-view render workload. Do not infer GPU performance from CPU timing alone.
- Handling and AI are separate work. Do not change physics to achieve a visual effect.

## Review checklist

Compare positions near the start, early/middle/end of the straight in halo view, both clean and with the TV effect. Check track visibility, shadow detail, scale, architecture continuity, unobstructed driving corridor, placement on other supported circuits, and render cost. A complete game/renderer rebuild is not currently justified.

## Pit-lane correction from the user

The right-hand side must read as a working pit lane, not a finely subdivided office facade. Prefer a paved operating lane, open garage depth, selected occupied bays and sparse crew/equipment. Simplify the upper building into broad shaded glazing and projecting roofs. Vary team frontage and roof mass in coherent groups; avoid identical railings, window grids and props in every bay. More triangles are not the goal: details need an observable purpose in the driver's view.

## Main-straight benchmark implemented

- Continuous grandstand seating, open crowd silhouettes, substantial roofs and exposed supports along the usable straight.
- Pit footprint includes a 10.8m working apron in front of 11m-deep garages. Selected open/closed bays, pit-box paint, sparse cars, crew and equipment establish its purpose. Connected spaces prevent module-end walls hiding the glazing/garages from the oblique driver view.
- Upper hospitality spaces use broad shaded glazing, fewer divisions, grouped team frontage and varied roof heights. Fence wires remain subordinate to the structures behind them.
- A trussed pedestrian bridge frames the forward view; original skyscrapers remain.
- Helmet placement now reveals the shaped wheel and gloves. Speed-dependent wheel movement remains, with a small live speed display and darker cockpit inner faces.
- Asphalt has broad longitudinal tone variation and rubber-dependent roughness. Ambient/reflected light is slightly lifted while retaining the warm low sun. The user's TV settings remain intact.
- Static scenery is batched in 96m sections. Crowd, seating, fence fabric and small pit props are omitted in performance mode.
- Pit lane is visual scenery in this pass; pit entry, service and race rules are separate work.

Validation: 15 focused placement, car-construction and contact checks passed; later connected-pit footprint checks passed on Croft Bay, Silverstone and Technical 8. Review the benchmark from halo at the beginning, middle and exit, and with the clean-picture toggle in visual-lab.html.

## Performance correction: smooth driving is mandatory

The user reported a severe, nauseating frame-rate regression after the main-straight pass. A short CPU-only visual check was insufficient; rendering cost must be tested with GPU/frame timing, race traffic and large windows.

Implemented: spatially culled kerb geometry with preserved authored normals/contact, continuous seat silhouettes, a single raked crowd surface per stand, vertex-colour batching for opaque architecture, one sign atlas, nearby-only small detail, simple roof shadow proxies, six-mesh race/ghost cars, frozen static world matrices, shader preparation at session setup, fewer full-screen blur reads, two-sample post-process antialiasing, a 1.25-megapixel scene ceiling, and automatic resolution reduction under sustained overload. HUD stays native resolution. Physics and AI decisions remain unchanged.

Development verification: F8 shows asynchronous GPU timing plus CPU/frame median and P95, draw calls, triangles and actual scene-buffer size. Turn it off after measuring. Keep only one game/preview renderer active during benchmarks.

## Fuller trackside foliage

The user's F1 reference emphasizes overlapping leafy masses, dark interiors, lighter outer leaves, irregular silhouettes and a mix of taller trees and lower growth beside the barriers. Sparse branch-tip sprigs spent rendering work without supplying enough canopy coverage. Preserve smooth driving; do not fill the whole outfield with trees.

- Replaced sparse sprigs with a four-cluster foliage atlas and twelve overlapping crown lobes per prototype. Six deterministic forms retain asymmetric branch growth and differing crown proportions.
- Nearby foliage uses 144 cards / 288 triangles, distant foliage 72 cards / 144 triangles: 60% fewer than before. Hidden twig geometry is reduced as well.
- Outward crown normals, shaded interiors and consistent lighting on both card faces keep individual planes from looking like cardboard. Cutout foliage remains instanced and depth-writing, with distance simplification. Full leaf self-shadowing is omitted; branches and foliage still cast ground shadows.
- Wider crowns are constrained by actual radial bounds across both geometry levels. A few lower companion trees sit next to existing groups, share their rendering batches, and close gaps beneath tall foliage. Placement is still limited to driver-visible areas outside barriers, away from buildings.
- Placement checks cover Croft Bay, Silverstone and Technical 8. Validate the final halo view, moving approach and seven-car render cost before extending this treatment.

Rendering references: NVIDIA GPU Gems 3 chapter 4 (https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-4-next-generation-speedtree-rendering), Three.js InstancedMesh (https://threejs.org/docs/pages/InstancedMesh.html), and Material cutout transparency (https://threejs.org/docs/pages/Material.html). These inform the technique, not asset copying or adopting SpeedTree middleware.

## Five new onboard references: track variation and driving-view priorities

Reviewed 2026-10-11 while the user reviews the tree pass. This is analysis; no game rendering changes were requested in this review.

### Asphalt is the next visual priority

- Image 1: a relatively calm straight still has broad tonal drift and long, faint, irregular tyre trails. Marks have different widths, opacity and lengths. Avoid adding the same amount of wear everywhere.
- Image 2: the fast bend has a wide fan of overlapping curved rubber traces. The worn region includes several trajectories, not a single uniformly dark racing-line stripe. Kerb scuffs continue the direction of road wear.
- Image 3: braking/approach areas have subtle darker longitudinal bands without turning the whole surface into a high-contrast pattern.
- Image 4: the tight corner combines denser rubber, cleaner adjacent asphalt, blended grey regions and finer marks. Wear belongs to the shape and use of the corner.
- Image 5: glancing light changes the apparent tone and sheen of the same class of surface. Texture cannot explain all the brightness variation; material response and light direction matter. Exact causes of individual patches cannot be established from screenshots alone.

Our current road already has aggregate colour/normal/roughness maps, lap-aligned traces, curvature-dependent wear and broad procedural tone. The issue is how these read together: fine grain dominates, broad variation is weak, and randomly seeded traces do not distinguish braking, loaded cornering and exit zones convincingly. Microaggregate should merge with distance while metre-scale wear remains legible. Do not respond by adding stronger uniform noise, a uniformly black stripe, wet-looking reflections or widespread physical bumps.

Proposed next asphalt pass: design several representative zones (quiet straight, braking approach, loaded fast bend and tight-corner exit), with non-repeating blended masks combining broad dark regions, faded strokes and occasional narrow marks. Follow plausible corner trajectories and vary density/width across the lap. Use restrained, correlated roughness differences so rubber and cleaner aggregate respond differently to the sun. Preserve the user's dark asphalt preference and existing TV treatment; inspect a clean view too. Prefer baked masks and the current material pass; measure GPU cost before expanding.

### Confirmed and newly clarified priorities

- Cockpit framing and construction still matter: references reveal a layered cockpit, substantial halo, recessed wheel/hands and tightly overlapping bodywork. Exposed suspension and distant nose contribute comparatively little to the screen. Refine existing shapes rather than adding unseen parts.
- Material separation is especially clear in image 5: broad painted highlights, smaller carbon response, tyre shoulder highlights and deep cockpit shade. Avoid one roughness/texture character across the car. Mirror reflections provide depth, but live per-frame mirror rendering is not a first priority given the performance requirement.
- Open corners can look convincing without buildings everywhere. Images 2–5 use continuous low fences/barriers, distant stands and an uneven tree skyline to establish depth while preserving open infield. Our uniform bare horizon needs composition, not indiscriminate props.
- Ground transitions matter: patchy turf, subtle dry/scuffed edges, service-road interruptions and different kerb types. Raised orange sections are distinct features, not a reason to make all striped kerbs equally high. Kerb scuffs should agree with nearby tyre paths.
- Nearby opponent cars are a major visible reference point. Refine rear-wing/body/tyre silhouettes within the existing small mesh/triangle budget; do not undo the field-car performance optimization.
- Attached still images do not establish suspension or camera-motion behavior. Evaluate those in motion separately; leave handling and AI unchanged during visual work.

Priority order: readable asphalt variation at driving distance; distinct material response/contact; intentional horizon and edge transitions; car and nearby-opponent silhouette refinements. Keep all decisions within the measured rendering budget.


## Asphalt pass and live review corrections

The user wants a visibly used racetrack: overlapping curved rubber, patches and occasional chalk-like abrasion. The first restrained continuous lines were too subtle. The subsequent dense parallel band was too uniform and too rough. The final direction is varied trajectories with breathing room, not a comb of equally rough lines.

- Precomputed lap surface map packs rubber, broad asphalt tone, subtle polish and the individual deposits' rough character. It covers the full authored width of every track; the old 12m mask could clamp wider road edges.
- Traffic paths use a cached smooth convolution and cubic interpolation. Both curvature and resulting lateral offset are smoothed to remove terrace-like lateral changes. Three-circuit checks bound changes at half-metre intervals and verify the periodic lap seam.
- Marks are finite tapered cubic arcs. Entry and exit positions, control points, influence of the usual line, lengths, widths and opacity vary independently. Slow/sharp corners have more wayward paths: wider exits, tighter entries and crossings between tracks. A sparse off-line set adds further irregular traffic history.
- Reduced stroke density, paired marks and the dark foundation beneath the common path after the user's screenshot showed a clumped comb. Broad shaded patches remain distributed across the road.
- A shared 512px directional scuff map supplies ragged/chalk-like breakup. Rough character now belongs to each deposited stroke: only a minority are strongly chalky; most are smoother or blended. There is no roughness noise applied indiscriminately over the whole road.
- Aggregate colour contrast is lower so broad wear can read. Tiny physical normals remain, with restrained polish and reflection changes. Preserve the dark asphalt preference, dry surface character, warm lighting and TV settings.
- No road geometry, overlays, elevation, handling or AI decisions were added. The lap map replaces the old fragment noise; scuff detail adds one small texture read. Dispose both maps with the world.

Validation: eight distinct focused checks across road wear, geometry-chunk attributes and resolution budgeting passed during this pass. The final three directly affected asphalt checks and production build passed after the last trajectory/density correction. These cover Croft Bay, Silverstone and Technical 8. Review includes clean and TV views, seven cars, moving scenery and a large window. Exact FPS improvements are not established by these variable local samples.


## Tree approach popping correction

The user reported a visible change in tree dimensions while approaching; the separate arrival of distant shadows is less bothersome. The cause was the 95m chunk-level LOD swap: the distant canopy removed half the cards and enlarged those remaining by 27%, then swapped back in one frame. Group-centre distance made this visible even on individual nearby trees.

The driver-visible trees now render the same accepted 144-card canopy at all distances. Existing texture mipmaps reduce fine leaf detail naturally. Instancing, spatial chunks and frustum culling remain. No crossfade, duplicate rendered crown or additional per-frame shader logic was added. Near-tree form and placement are preserved; general shadow-distance policy remains unchanged.

Matched local review at Croft Bay position 1530, classic halo, seven opponents, TV effect, normal quality and 1280×720 buffer: triangles 282,785 → 283,793 (+1,008, about 0.36%); draw calls 209 → 209. GPU median/P95 8.58/10.28 → 8.67/10.31 ms; CPU median 2.70 → 2.70 ms; frame interval median/P95 12.10/18.20 ms in both samples. This is a renderer sample, not a full-race FPS guarantee. Five existing tree-geometry and placement checks passed; final production build succeeded. Moving approach reviewed separately.

This supersedes the earlier note about switching to the 72-card distant canopy. That prototype is still generated for existing form bounds but is not used to render a tree.


## Firmer onboard camera experiment

The user found the sideways reaction to a steering flick arcade-like and wanted to try a much firmer camera. Removed the independent lateral cornering-force offset (`0.0016 * yawRate * forwardSpeed`) from Halo and Hood views. The camera follows the car's heading directly; there is no added steering-driven pan or lateral drift.

Horizontal shake means the separate small left/right vibration on kerbs or grass. It remains as road feedback, alongside vertical rumble, existing pitch and the chassis contact-suspension movement. Camera framing, speed FOV, chase behavior and handling are preserved so the steering-sway experiment can be judged on its own.

Validation: three camera regression checks verify identical onboard camera pose for opposite steering/yaw-rate inputs at the same vehicle pose, plus bounded kerb vibration; four existing contact-suspension checks passed. Final TypeScript/Vite/API build succeeded. No additional per-frame rendering work was introduced. The static preview confirms loading; subjective steering feel still needs the user's driving review.
