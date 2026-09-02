// Static route map: tool name -> backend
const ROUTE_MAP = new Map([
    // === Detection & Session (workflow) ===
    ['detect_engine', 'workflow'],
    ['load_game', 'workflow'],
    ['game_status', 'workflow'],
    ['list_available_tools', 'workflow'],
    ['find_steam_games', 'workflow'],
    // === Workflow Tools ===
    ['mod_this_game', 'workflow'],
    ['find_gameplay_values', 'workflow'],
    ['build_and_deploy', 'workflow'],
    ['debug_mod', 'workflow'],
    ['scaffold_mod', 'workflow'],
    // === Native Analysis Tools (ported from binary-analyzer-ultra) ===
    ['analyze_pe_full', 'native'],
    ['analyze_dll_exports', 'native'],
    ['analyze_dll_imports', 'native'],
    ['analyze_file_format', 'native'],
    ['analyze_memory_layout', 'native'],
    ['hex_read', 'native'],
    ['hex_write', 'native'],
    ['hex_search', 'native'],
    ['hex_replace', 'native'],
    ['pattern_scan', 'native'],
    ['pattern_scan_all', 'native'],
    ['extract_strings_advanced', 'native'],
    ['extract_resources_full', 'native'],
    ['edit_string_table', 'native'],
    ['inject_resource', 'native'],
    ['compare_binaries_detailed', 'native'],
    ['calculate_checksums', 'native'],
    ['fix_pe_checksum', 'native'],
    ['rva_to_offset', 'native'],
    ['offset_to_rva', 'native'],
    ['disassemble_function', 'native'],
    ['create_patch', 'native'],
    ['apply_patch', 'native'],
    ['compress_file', 'native'],
    ['decompress_file', 'native'],
    ['encrypt_decrypt_file', 'native'],
    ['analyze_wad', 'native'],
    // IL2CPP native tools
    ['unity_il2cpp_dump_metadata', 'native'],
    ['unity_il2cpp_find_class', 'native'],
    ['actk_scan_obscured_values', 'native'],
    ['actk_decrypt_value', 'native'],
    ['actk_struct_info', 'native'],
    // PlayerPrefs native tools
    ['unity_playerprefs_read', 'native'],
    ['unity_playerprefs_write', 'native'],
    // Godot native tools
    ['analyze_godot_pck', 'native'],
    // Game save tools
    ['analyze_game_save', 'native'],
    // Smart binary analyzer (ported)
    ['search_binary_pattern', 'native'],
    ['extract_dll_classes', 'native'],
    ['extract_strings', 'native'],
    ['analyze_dll_structure', 'native'],
    // === Unity Mono Delegate (-> UnityDecompilerMcp.exe) ===
    ['load_assembly', 'unity-decompiler'],
    ['list_types', 'unity-decompiler'],
    ['inspect_type', 'unity-decompiler'],
    ['decompile_type', 'unity-decompiler'],
    ['decompile_method', 'unity-decompiler'],
    ['get_method_il', 'unity-decompiler'],
    ['search_code', 'unity-decompiler'],
    ['find_references', 'unity-decompiler'],
    ['get_inheritance_tree', 'unity-decompiler'],
    ['list_monobehaviours', 'unity-decompiler'],
    ['list_scriptableobjects', 'unity-decompiler'],
    ['get_serialized_fields', 'unity-decompiler'],
    ['generate_harmony_patch', 'unity-decompiler'],
    ['generate_plugin', 'unity-decompiler'],
    ['compile_plugin', 'unity-decompiler'],
    ['validate_assembly', 'unity-decompiler'],
    ['validate_patch_target', 'unity-decompiler'],
    ['verify_patches', 'unity-decompiler'],
    ['compare_signatures', 'unity-decompiler'],
    ['diff_assemblies', 'unity-decompiler'],
    ['find_renamed_types', 'unity-decompiler'],
    ['detect_networking', 'unity-decompiler'],
    ['analyze_bepinex_log', 'unity-decompiler'],
    ['analyze_save_format', 'unity-decompiler'],
    ['read_playerprefs', 'unity-decompiler'],
    ['read_unity_assets_info', 'unity-decompiler'],
    ['list_patchable_methods', 'unity-decompiler'],
    // === Unreal Delegate (-> UnrealAssetMcp.exe) ===
    ['open_game', 'unreal-assets'],
    ['unreal_game_status', 'unreal-assets'],
    ['list_assets', 'unreal-assets'],
    ['search_assets', 'unreal-assets'],
    ['read_asset', 'unreal-assets'],
    ['read_asset_export', 'unreal-assets'],
    ['list_exports', 'unreal-assets'],
    ['read_blueprint', 'unreal-assets'],
    ['find_blueprints_of_type', 'unreal-assets'],
    ['read_datatable', 'unreal-assets'],
    ['get_class_hierarchy', 'unreal-assets'],
    // === Java Delegate (-> jar-editor server.py) ===
    ['jar_open', 'jar-editor'],
    ['jar_close', 'jar-editor'],
    ['jar_list', 'jar-editor'],
    ['jar_list_sessions', 'jar-editor'],
    ['jar_read_class', 'jar-editor'],
    ['jar_read_file', 'jar-editor'],
    ['jar_search', 'jar-editor'],
    ['jar_search_bytecode', 'jar-editor'],
    ['jar_search_opcodes', 'jar-editor'],
    ['jar_inspect_constant_pool', 'jar-editor'],
    ['jar_edit_class_constants', 'jar-editor'],
    ['jar_edit_constant_pool', 'jar-editor'],
    ['jar_edit_file', 'jar-editor'],
    ['jar_hex_edit', 'jar-editor'],
    ['jar_hex_view', 'jar-editor'],
    ['jar_compile_java', 'jar-editor'],
    ['jar_repack', 'jar-editor'],
    ['jar_diff', 'jar-editor'],
    ['jar_add_file', 'jar-editor'],
    ['jar_add_file_content', 'jar-editor'],
    ['jar_restore_file', 'jar-editor'],
    ['jar_scaffold_mod', 'jar-editor'],
    ['jar_preset_apply', 'jar-editor'],
    ['jar_preset_list', 'jar-editor'],
    ['jar_preset_save', 'jar-editor'],
    ['jar_detect_mod_info', 'jar-editor'],
]);
export function getToolBackend(toolName) {
    return ROUTE_MAP.get(toolName);
}
export function getAllToolNames() {
    return Array.from(ROUTE_MAP.keys());
}
export function getToolsByBackend(backend) {
    return Array.from(ROUTE_MAP.entries())
        .filter(([_, b]) => b === backend)
        .map(([name]) => name);
}
export function isValidTool(toolName) {
    return ROUTE_MAP.has(toolName);
}
//# sourceMappingURL=router.js.map