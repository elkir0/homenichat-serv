<?php
/**
 * FreePBX List Trunks Script
 * Lists all trunks from FreePBX using MySQL direct query
 *
 * Note: getTrunks() crashes on FreePBX 17 due to BMO module loading issue
 * Solution: Use MySQL direct query instead
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
    $db = $freepbx->Database;

    // Use MySQL direct query instead of getTrunks() which crashes on FreePBX 17
    $stmt = $db->query("SELECT trunkid, name, tech, channelid, outcid, disabled FROM trunks ORDER BY trunkid");
    $trunkList = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $trunks = [];
    foreach ($trunkList as $trunk) {
        $trunks[] = [
            "id" => $trunk['trunkid'],
            "name" => $trunk['name'],
            "tech" => $trunk['tech'],
            "channelid" => isset($trunk['channelid']) ? $trunk['channelid'] : '',
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
