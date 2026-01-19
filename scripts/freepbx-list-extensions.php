<?php
/**
 * FreePBX List Extensions Script
 * Lists all extensions from FreePBX
 *
 * Usage: php freepbx-list-extensions.php
 *
 * Returns JSON:
 *   {"success": true, "extensions": [...]}
 *   {"success": false, "error": "Error message"}
 */

// Load FreePBX
if (!file_exists('/etc/freepbx.conf')) {
    echo json_encode(["success" => false, "error" => "FreePBX not installed"]);
    exit(1);
}

require_once '/etc/freepbx.conf';

try {
    $freepbx = FreePBX::Create();

    $users = $freepbx->Core->getAllUsers();
    $extensions = [];

    foreach ($users as $user) {
        $extensions[] = [
            "extension" => $user['extension'],
            "name" => $user['name'],
            "tech" => isset($user['tech']) ? $user['tech'] : 'pjsip',
            "context" => isset($user['context']) ? $user['context'] : 'from-internal'
        ];
    }

    echo json_encode([
        "success" => true,
        "count" => count($extensions),
        "extensions" => $extensions
    ]);

} catch (Exception $e) {
    echo json_encode(["success" => false, "error" => $e->getMessage()]);
    exit(1);
}
