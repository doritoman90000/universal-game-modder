import { getDetectionTools } from './detection-tools.js';
import { getWorkflowTools } from './workflow-tools.js';
import { getNativeToolDefinitions } from './native/index.js';
import { getUnpackTools } from './unpack-tools.js';
import { getDecodeTools } from './decode-tools.js';
import { getNativeComprehensionTools } from './native-comprehension-tools.js';
import { getUnityDelegateTools } from './delegates/unity-decompiler.js';
import { getUnrealDelegateTools } from './delegates/unreal-assets.js';
import { getJarDelegateTools } from './delegates/jar-editor.js';
let allTools = null;
export function getAllTools() {
    if (allTools)
        return allTools;
    allTools = [
        ...getDetectionTools(),
        ...getWorkflowTools(),
        ...getNativeToolDefinitions(),
        ...getUnpackTools(),
        ...getDecodeTools(),
        ...getNativeComprehensionTools(),
        ...getUnityDelegateTools(),
        ...getUnrealDelegateTools(),
        ...getJarDelegateTools(),
    ];
    return allTools;
}
export function getToolByName(name) {
    return getAllTools().find(t => t.name === name);
}
//# sourceMappingURL=index.js.map