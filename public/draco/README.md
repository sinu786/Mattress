# Draco decoders

If your GLB is Draco-compressed, download decoders from the Three.js repo:

https://github.com/mrdoob/three.js/tree/dev/examples/jsm/libs/draco

Copy these files into this folder:
- draco_decoder.js
- draco_decoder.wasm
- draco_wasm_wrapper.js
- draco_decoder.wasm.js (if present)

Then GLTFLoader will auto-use them for Draco meshes.
