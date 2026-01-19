<?php
/**
 * FreePBX Delete Extension Script
 * Deletes a PJSIP extension from FreePBX
 *
 * Usage: php freepbx-delete-extension.php <extension>
 *
 * Example:
 *   php freepbx-delete-extension.php 1000
 *
 * Returns JSON:
 *   {"success": true}
 *   {"success": false, "error": "Error message"}
 */

if ($argc < 2) {
    echo json_encode([
        "success" => false,
        "error" => "Usage: php freepbx-delete-extension.php <extension>"
    ]);
    exit(1);
}

$extension = $argv[1];

// Validate extension number
if (!preg_match('/^\d{3,6}$/', $extension)) {
    echo json_encode(["success" => false, "error" => "Invalid extension number"]);
    exit(1);
}

// Load FreePBX
if (!file_exists('/etc/freepbx.conf')) {
    echo json_encode(["success" => false, "error" => "FreePBX not installed"]);
    exit(1);
}

require_once '/etc/freepbx.conf';

try {
    $freepbx = FreePBX::Create();

    // Check if extension exists
    $existing = $freepbx->Core->getUser($extension);
    if (!$existing) {
        echo json_encode(["success" => false, "error" => "Extension $extension not found"]);
        exit(0);
    }

    // Delete device first (PJSIP endpoint)
    $freepbx->Core->delDevice($extension);

    // Delete user
    $freepbx->Core->delUser($extension);

    // Mark configuration as needing reload
    needreload();

    echo json_encode(["success" => true, "extension" => $extension]);

} catch (Exception $e) {
    echo json_encode(["success" => false, "error" => $e->getMessage()]);
    exit(1);
}
