const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const logger = console;

const execAsync = promisify(exec);

/**
 * Convertit un fichier audio d'un format vers un autre en utilisant FFmpeg
 */
class AudioConverter {
  constructor() {
    this.tempDir = '/tmp/audio-conversions';
    this.ensureTempDir();
  }

  async ensureTempDir() {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
    } catch (error) {
      logger.error('Error creating temp directory:', error);
    }
  }

  /**
   * Convertit un buffer audio WebM/OGG vers MP3
   * @param {Buffer} inputBuffer - Le buffer audio à convertir
   * @param {Object} options - Options de conversion
   * @returns {Promise<{buffer: Buffer, mimeType: string, extension: string}>}
   */
  async convertToMp3(inputBuffer, options = {}) {
    const tempId = crypto.randomBytes(16).toString('hex');
    const inputPath = path.join(this.tempDir, `input_${tempId}.webm`);
    const outputPath = path.join(this.tempDir, `output_${tempId}.mp3`);

    try {
      // Écrire le buffer dans un fichier temporaire
      await fs.writeFile(inputPath, inputBuffer);

      // Commande FFmpeg pour convertir en MP3
      // -i : input file
      // -acodec mp3 : codec audio MP3
      // -b:a 128k : bitrate audio 128kbps
      // -ar 44100 : sample rate 44.1kHz
      const command = `ffmpeg -i "${inputPath}" -acodec mp3 -b:a 128k -ar 44100 "${outputPath}" -y`;
      
      logger.info('Executing FFmpeg command:', command);
      const { stdout, stderr } = await execAsync(command);
      
      if (stderr && !stderr.includes('overwrite')) {
        logger.warn('FFmpeg stderr:', stderr);
      }

      // Lire le fichier converti
      const outputBuffer = await fs.readFile(outputPath);

      // Nettoyer les fichiers temporaires
      await this.cleanup(inputPath, outputPath);

      return {
        buffer: outputBuffer,
        mimeType: 'audio/mpeg',
        extension: 'mp3'
      };
    } catch (error) {
      // Nettoyer en cas d'erreur
      await this.cleanup(inputPath, outputPath);
      throw new Error(`Audio conversion failed: ${error.message}`);
    }
  }

  /**
   * Convertit un buffer audio WebM/OGG vers AAC/M4A
   * @param {Buffer} inputBuffer - Le buffer audio à convertir
   * @param {Object} options - Options de conversion
   * @returns {Promise<{buffer: Buffer, mimeType: string, extension: string}>}
   */
  async convertToAac(inputBuffer, options = {}) {
    const tempId = crypto.randomBytes(16).toString('hex');
    const inputPath = path.join(this.tempDir, `input_${tempId}.webm`);
    const outputPath = path.join(this.tempDir, `output_${tempId}.m4a`);

    try {
      // Écrire le buffer dans un fichier temporaire
      await fs.writeFile(inputPath, inputBuffer);

      // Commande FFmpeg pour convertir en AAC/M4A
      // -i : input file
      // -c:a aac : codec audio AAC
      // -b:a 128k : bitrate audio 128kbps
      // -movflags +faststart : optimise pour streaming
      const command = `ffmpeg -i "${inputPath}" -c:a aac -b:a 128k -movflags +faststart "${outputPath}" -y`;
      
      logger.info('Executing FFmpeg command:', command);
      const { stdout, stderr } = await execAsync(command);
      
      if (stderr && !stderr.includes('overwrite')) {
        logger.warn('FFmpeg stderr:', stderr);
      }

      // Lire le fichier converti
      const outputBuffer = await fs.readFile(outputPath);

      // Nettoyer les fichiers temporaires
      await this.cleanup(inputPath, outputPath);

      return {
        buffer: outputBuffer,
        mimeType: 'audio/mp4',
        extension: 'm4a'
      };
    } catch (error) {
      // Nettoyer en cas d'erreur
      await this.cleanup(inputPath, outputPath);
      throw new Error(`Audio conversion failed: ${error.message}`);
    }
  }

  /**
   * Détermine le meilleur format de sortie pour Meta WhatsApp
   * @param {string} inputMimeType - Le type MIME d'entrée
   * @returns {string} Le format de sortie recommandé
   */
  getBestOutputFormat(inputMimeType) {
    // Meta supporte: audio/aac, audio/mp4, audio/mpeg, audio/amr, audio/ogg
    // MP3 est le plus universel et bien supporté
    return 'mp3';
  }

  /**
   * Nettoie les fichiers temporaires
   */
  async cleanup(...filePaths) {
    for (const filePath of filePaths) {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        // Ignorer les erreurs de suppression
      }
    }
  }

  /**
   * Obtient des informations sur un fichier audio
   * @param {Buffer} inputBuffer - Le buffer audio
   * @returns {Promise<Object>} Informations sur le fichier
   */
  async getAudioInfo(inputBuffer) {
    const tempId = crypto.randomBytes(16).toString('hex');
    const inputPath = path.join(this.tempDir, `probe_${tempId}`);

    try {
      await fs.writeFile(inputPath, inputBuffer);

      // Utiliser ffprobe pour obtenir les infos
      const command = `ffprobe -v quiet -print_format json -show_format -show_streams "${inputPath}"`;
      const { stdout } = await execAsync(command);

      await fs.unlink(inputPath);

      return JSON.parse(stdout);
    } catch (error) {
      await this.cleanup(inputPath);
      throw new Error(`Failed to get audio info: ${error.message}`);
    }
  }
}

module.exports = new AudioConverter();