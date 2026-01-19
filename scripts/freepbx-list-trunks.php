<?php
/**
 * FreePBX List Trunks Script
 * Lists all trunks from FreePBX
 *
 * Usage: php freepbx-list-trunks.php
 *
 * Returns JSON:
 *   {"success": true, "trunks": [...]}
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

    $trunkList = $freepbx->Core->getTrunks();
    $trunks = [];

    foreach ($trunkList as $trunk) {
        $trunks[] = [
            "id" => $trunk['trunkid'],
            "name" => $trunk['name'],
            "tech" => $trunk['tech'],
            "outcid" => isset($trunk['outcid']) ? $trunk['outcid'] : '',
            "disabled" => isset($trunk['disabled']) ? $trunk['disabled'] : 'off'
        ];
    }

    echo json_encode([
        "success" => true,
        "count" => count($trunks),
        "trunks" => $trunks
    ]);

} catch (Exception $e) {
    echo json_encode(["success" => false, "error" => $e->getMessage()]);
    exit(1);
}
