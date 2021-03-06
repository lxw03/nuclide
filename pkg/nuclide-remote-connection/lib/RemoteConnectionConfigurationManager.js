/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 * @format
 */

/* global localStorage */

import type {ServerConnectionConfiguration} from './ServerConnection';

import crypto from 'crypto';
import invariant from 'assert';
import {getLogger} from 'log4js';
import keytarWrapper from '../../commons-atom/keytarWrapper';

const CONFIG_DIR = 'nuclide-connections';

const logger = getLogger('nuclide-remote-connection');

/**
 * Version of ServerConnectionConfiguration that uses string instead of Buffer for fields so it can
 * be translated directly to/from JSON.
 */
type SerializableServerConnectionConfiguration = {
  host: string,
  port: number,
  family?: 4 | 6,
  certificateAuthorityCertificate?: string,
  clientCertificate?: string,
  clientKey?: string,
};

// Insecure configs are used for testing only.
function isInsecure(config: ServerConnectionConfiguration): boolean {
  return (
    config.clientKey == null &&
    config.clientCertificate == null &&
    config.certificateAuthorityCertificate == null
  );
}

function getStorageKey(host: string): string {
  return `${CONFIG_DIR}:${host}`;
}

export async function getConnectionConfig(
  host: string,
): Promise<?ServerConnectionConfiguration> {
  const storedConfig = localStorage.getItem(getStorageKey(host));
  if (storedConfig == null) {
    return null;
  }
  try {
    return decryptConfig(JSON.parse(storedConfig));
  } catch (e) {
    logger.error(`The configuration file for ${host} is corrupted.`, e);
    return null;
  }
}

export async function setConnectionConfig(
  config: ServerConnectionConfiguration,
  ipAddress: string,
): Promise<void> {
  // Don't attempt to store insecure connections.
  // Insecure connections are used for testing and will fail the encryption call below.
  if (isInsecure(config)) {
    return;
  }

  try {
    const encrypted = JSON.stringify(await encryptConfig(config));
    localStorage.setItem(getStorageKey(config.host), encrypted);
    // Store configurations by their IP address as well.
    // This way, multiple aliases for the same hostname can reuse a single connection.
    localStorage.setItem(getStorageKey(ipAddress), encrypted);
  } catch (e) {
    logger.error(`Failed to store configuration file for ${config.host}.`, e);
  }
}

export async function clearConnectionConfig(host: string): Promise<void> {
  try {
    localStorage.removeItem(getStorageKey(host));
  } catch (e) {
    logger.error(`Failed to clear configuration for ${host}.`, e);
  }
}

/**
 * Encrypts the clientKey of a ConnectionConfig.
 * @param remoteProjectConfig - The config with the clientKey we want encrypted.
 * @return returns the passed in config with the clientKey encrypted.
 */
async function encryptConfig(
  remoteProjectConfig: ServerConnectionConfiguration,
): Promise<SerializableServerConnectionConfiguration> {
  const sha1 = crypto.createHash('sha1');
  sha1.update(`${remoteProjectConfig.host}:${remoteProjectConfig.port}`);
  const sha1sum = sha1.digest('hex');

  const {
    certificateAuthorityCertificate,
    clientCertificate,
    clientKey,
  } = remoteProjectConfig;
  invariant(clientKey);
  const realClientKey = clientKey.toString(); // Convert from Buffer to string.
  const {salt, password, encryptedString} = encryptString(realClientKey);
  await keytarWrapper.replacePassword(
    'nuclide.remoteProjectConfig',
    sha1sum,
    password,
  );

  const clientKeyWithSalt = encryptedString + '.' + salt;

  invariant(certificateAuthorityCertificate);
  invariant(clientCertificate);

  return {
    host: remoteProjectConfig.host,
    port: remoteProjectConfig.port,
    family: remoteProjectConfig.family,
    certificateAuthorityCertificate: certificateAuthorityCertificate.toString(),
    clientCertificate: clientCertificate.toString(),
    clientKey: clientKeyWithSalt,
  };
}

/**
 * Decrypts the clientKey of a SerializableServerConnectionConfiguration.
 * @param remoteProjectConfig - The config with the clientKey we want encrypted.
 * @return returns the passed in config with the clientKey encrypted.
 */
async function decryptConfig(
  remoteProjectConfig: SerializableServerConnectionConfiguration,
): Promise<ServerConnectionConfiguration> {
  const sha1 = crypto.createHash('sha1');
  sha1.update(`${remoteProjectConfig.host}:${remoteProjectConfig.port}`);
  const sha1sum = sha1.digest('hex');

  const password = await keytarWrapper.getPassword(
    'nuclide.remoteProjectConfig',
    sha1sum,
  );

  if (password == null) {
    throw new Error('Cannot find password for encrypted client key');
  }

  const {
    certificateAuthorityCertificate,
    clientCertificate,
    clientKey,
  } = remoteProjectConfig;
  // flowlint-next-line sketchy-null-string:off
  invariant(clientKey);
  const [encryptedString, salt] = clientKey.split('.');

  if (!encryptedString || !salt) {
    throw new Error('Cannot decrypt client key');
  }

  const restoredClientKey = decryptString(encryptedString, password, salt);
  // "nolint" is to suppress ArcanistPrivateKeyLinter errors
  if (
    !restoredClientKey.startsWith('-----BEGIN RSA PRIVATE KEY-----') // nolint
  ) {
    getLogger('nuclide-remote-connection').error(
      `decrypted client key did not start with expected header: ${restoredClientKey}`,
    );
  }

  // flowlint-next-line sketchy-null-string:off
  invariant(certificateAuthorityCertificate);
  // flowlint-next-line sketchy-null-string:off
  invariant(clientCertificate);
  return {
    host: remoteProjectConfig.host,
    port: remoteProjectConfig.port,
    family: remoteProjectConfig.family,
    certificateAuthorityCertificate: new Buffer(
      certificateAuthorityCertificate,
    ),
    clientCertificate: new Buffer(clientCertificate),
    clientKey: new Buffer(restoredClientKey),
  };
}

function decryptString(text: string, password: string, salt: string): string {
  const decipher = crypto.createDecipheriv(
    'aes-128-cbc',
    new Buffer(password, 'base64'),
    new Buffer(salt, 'base64'),
  );

  let decryptedString = decipher.update(text, 'base64', 'utf8');
  decryptedString += decipher.final('utf8');

  return decryptedString;
}

function encryptString(
  text: string,
): {password: string, salt: string, encryptedString: string} {
  const password = crypto.randomBytes(16).toString('base64');
  const salt = crypto.randomBytes(16).toString('base64');

  const cipher = crypto.createCipheriv(
    'aes-128-cbc',
    new Buffer(password, 'base64'),
    new Buffer(salt, 'base64'),
  );

  let encryptedString = cipher.update(
    text,
    /* input_encoding */ 'utf8',
    /* output_encoding */ 'base64',
  );
  encryptedString += cipher.final('base64');

  return {
    password,
    salt,
    encryptedString,
  };
}

export const __test__ = {
  decryptString,
  encryptString,
};
