<?php
/**
 * FreePBX Create Extension Script
 * Creates a PJSIP extension visible in FreePBX GUI
 *
 * Usage: php freepbx-create-extension.php <extension> <name> <secret> [outboundcid]
 *
 * Example:
 *   php freepbx-create-extension.php 1000 "WebRTC User" SecretPass123 "+590690402352"
 *
 * Returns JSON:
 *   {"success": true, "extension": "1000"}
 *   {"success": false, "error": "Error message"}
 */

if ($argc < 4) {
    echo json_encode([
        "success" => false,
        "error" => "Usage: php freepbx-create-extension.php <extension> <name> <secret> [outboundcid]"
    ]);
    exit(1);
}

$extension = $argv[1];
$name = $argv[2];
$secret = $argv[3];
$outboundcid = isset($argv[4]) ? $argv[4] : "";

// Validate extension number
if (!preg_match('/^\d{3,6}$/', $extension)) {
    echo json_encode(["success" => false, "error" => "Invalid extension number (must be 3-6 digits)"]);
    exit(1);
}

// Load FreePBX
if (!file_exists('/etc/freepbx.conf')) {
    echo json_encode(["success" => false, "error" => "FreePBX not installed (/etc/freepbx.conf not found)"]);
    exit(1);
}

require_once '/etc/freepbx.conf';

try {
    $freepbx = FreePBX::Create();

    // Check if extension already exists
    $existing = $freepbx->Core->getUser($extension);
    if ($existing) {
        echo json_encode(["success" => false, "error" => "Extension $extension already exists"]);
        exit(0);
    }

    // Settings for processQuickCreate
    // IMPORTANT: "vm" parameter is REQUIRED to avoid Voicemail module error
    $settings = [
        "name" => $name,
        "secret" => $secret,
        "tech" => "pjsip",
        "outboundcid" => $outboundcid,
        // Voicemail settings - REQUIRED even if disabled
        "vm" => "no",
        "vmpwd" => "",
        "email" => ""
    ];

    // Create extension using processQuickCreate
    // This creates both user and device in one call
    $result = $freepbx->Core->processQuickCreate("pjsip", $extension, $settings);

    if ($result) {
        // Configure WebRTC settings for the extension
        // These are stored in the sip/pjsip tables
        try {
            $device = $freepbx->Core->getDevice($extension);
            if ($device) {
                // WebRTC-specific settings
                $device['webrtc'] = 'yes';
                $device['dtls_auto_generate_cert'] = 'yes';
                $device['ice_support'] = 'yes';
                $device['direct_media'] = 'no';
                $device['force_rport'] = 'yes';
                $device['rewrite_contact'] = 'yes';
                $device['rtp_symmetric'] = 'yes';
                $device['media_encryption'] = 'dtls';
                $device['media_use_received_transport'] = 'yes';
                $device['rtcp_mux'] = 'yes';
                $device['transport'] = 'transport-wss,transport-ws,transport-udp';
                $device['allow'] = 'g722,ulaw,alaw,opus';
                $device['disallow'] = 'all';

                $freepbx->Core->editDevice($extension, $device);
            }
        } catch (Exception $e) {
            // Non-fatal: WebRTC settings can be added manually
            error_log("Warning: Could not set WebRTC options: " . $e->getMessage());
        }

        // Mark configuration as needing reload
        needreload();

        echo json_encode([
            "success" => true,
            "extension" => $extension,
            "name" => $name
        ]);
    } else {
        echo json_encode(["success" => false, "error" => "processQuickCreate returned false"]);
    }

} catch (Exception $e) {
    echo json_encode(["success" => false, "error" => $e->getMessage()]);
    exit(1);
}
