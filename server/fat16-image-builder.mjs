import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const BYTES_PER_SECTOR = 512;
const RESERVED_SECTORS = 1;
const FAT_COUNT = 2;
const ROOT_DIRECTORY_ENTRIES = 512;
const ROOT_DIRECTORY_SECTORS = (ROOT_DIRECTORY_ENTRIES * 32) / BYTES_PER_SECTOR;
const PARTITION_START_SECTOR = 63;
const SECTORS_PER_TRACK = 63;
const HEAD_COUNT = 16;
const MIN_IMAGE_SIZE = 64 * 1024 * 1024;
const MAX_FAT16_CLUSTERS = 65524;
const MIN_FAT16_CLUSTERS = 4085;
const DEFAULT_VOLUME_LABEL = "DOSDISK";
const DOS_ALLOWED_CHARS = /^[A-Z0-9!#$%&'()\-@^_`{}~]+$/;

export async function describeSourceDirectory(sourceDirectory) {
  const directoryEntries = await readdir(sourceDirectory, { withFileTypes: true });
  const fileEntries = [];

  for (const entry of directoryEntries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    if (!entry.isFile()) {
      throw new Error(`当前只支持根目录文件打包，发现不支持的条目: ${entry.name}`);
    }

    const filePath = path.join(sourceDirectory, entry.name);
    const fileStat = await stat(filePath);

    fileEntries.push({
      name: entry.name,
      sourcePath: filePath,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      dosName: normalizeDosFileName(entry.name).displayName
    });
  }

  fileEntries.sort((left, right) => left.dosName.localeCompare(right.dosName, "en"));

  return {
    files: fileEntries,
    fileCount: fileEntries.length,
    totalSize: fileEntries.reduce((sum, fileEntry) => sum + fileEntry.size, 0)
  };
}

export async function buildFat16Image({ sourceDirectory, outputPath, metadataPath, volumeLabel = DEFAULT_VOLUME_LABEL, virtualFiles = [] }) {
  // 步骤 1：读取源目录和附加虚拟文件，生成确定性的输入清单与签名。
  const sourceDescription = await describeSourceDirectory(sourceDirectory);
  const normalizedVirtualFiles = normalizeVirtualFiles(virtualFiles);
  const sourceFiles = await Promise.all(sourceDescription.files.map(async (fileEntry) => ({ ...fileEntry, buffer: await readFile(fileEntry.sourcePath) })));
  const allFiles = [...sourceFiles, ...normalizedVirtualFiles];
  const signature = buildSourceSignature(allFiles);

  validateFileSet(allFiles);

  // 步骤 2：根据文件总量规划 FAT16 分区布局，预留适中的写入空间给游戏存档。
  const totalFileSize = allFiles.reduce((sum, fileEntry) => sum + fileEntry.size, 0);
  const layout = planFat16Layout(totalFileSize);
  const imageBuffer = Buffer.alloc(layout.imageSizeBytes);

  // 步骤 3：写入 MBR、分区引导扇区、FAT 表、根目录和数据区，生成 DOS 可识别的数据盘。
  writeMbr(imageBuffer, layout);
  writeBootSector(imageBuffer, layout, volumeLabel);

  const allocation = writeFileSystemPayload(imageBuffer, layout, allFiles, volumeLabel);

  await writeFile(outputPath, imageBuffer);

  const metadata = {
    signature,
    volumeLabel: normalizeVolumeLabel(volumeLabel),
    sourceDirectory,
    fileCount: allFiles.length,
    totalFileSize,
    imageSizeBytes: imageBuffer.length,
    clusterSizeBytes: layout.sectorsPerCluster * BYTES_PER_SECTOR,
    files: allocation.files.map(({ dosName, size, startCluster, clusters }) => ({ dosName, size, startCluster, clusters }))
  };

  if (metadataPath) {
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  }

  return metadata;
}

function normalizeVirtualFiles(virtualFiles) {
  return virtualFiles.map((virtualFile) => {
    const normalizedName = normalizeDosFileName(virtualFile.name);
    const buffer = Buffer.isBuffer(virtualFile.content) ? virtualFile.content : Buffer.from(virtualFile.content);

    return {
      name: virtualFile.name,
      dosName: normalizedName.displayName,
      size: buffer.length,
      mtimeMs: Date.now(),
      buffer
    };
  });
}

function validateFileSet(files) {
  const seenNames = new Set();

  for (const fileEntry of files) {
    if (seenNames.has(fileEntry.dosName)) {
      throw new Error(`生成 FAT16 镜像失败，存在重复的 DOS 文件名: ${fileEntry.dosName}`);
    }

    seenNames.add(fileEntry.dosName);
  }
}

function buildSourceSignature(files) {
  const hash = createHash("sha256");

  for (const fileEntry of files) {
    hash.update(fileEntry.dosName);
    hash.update("\0");
    hash.update(String(fileEntry.size));
    hash.update("\0");
    hash.update(String(Math.trunc(fileEntry.mtimeMs)));
    hash.update("\0");
    hash.update(fileEntry.buffer);
    hash.update("\0");
  }

  return hash.digest("hex");
}

function planFat16Layout(totalFileSize) {
  const requestedSize = Math.max(MIN_IMAGE_SIZE, roundUpToMiB(totalFileSize + 16 * 1024 * 1024));
  const imageSizeBytes = alignToSector(requestedSize);
  const totalImageSectors = imageSizeBytes / BYTES_PER_SECTOR;
  const partitionSectors = totalImageSectors - PARTITION_START_SECTOR;
  const sectorsPerCluster = chooseSectorsPerCluster(partitionSectors);
  let fatSectors = 1;
  let clusterCount = 0;

  // 步骤 1：迭代 FAT 表大小，直到簇数量与 FAT 占用收敛。
  while (true) {
    const dataSectors = partitionSectors - RESERVED_SECTORS - ROOT_DIRECTORY_SECTORS - FAT_COUNT * fatSectors;
    clusterCount = Math.floor(dataSectors / sectorsPerCluster);
    const nextFatSectors = Math.ceil(((clusterCount + 2) * 2) / BYTES_PER_SECTOR);

    if (nextFatSectors === fatSectors) {
      break;
    }

    fatSectors = nextFatSectors;
  }

  if (clusterCount < MIN_FAT16_CLUSTERS || clusterCount > MAX_FAT16_CLUSTERS) {
    throw new Error(`FAT16 布局规划失败，簇数量 ${clusterCount} 超出 FAT16 可用范围。`);
  }

  const partitionOffset = PARTITION_START_SECTOR * BYTES_PER_SECTOR;
  const fat1Offset = partitionOffset + RESERVED_SECTORS * BYTES_PER_SECTOR;
  const fat2Offset = fat1Offset + fatSectors * BYTES_PER_SECTOR;
  const rootDirectoryOffset = fat2Offset + fatSectors * BYTES_PER_SECTOR;
  const dataOffset = rootDirectoryOffset + ROOT_DIRECTORY_SECTORS * BYTES_PER_SECTOR;
  const dataSectors = partitionSectors - RESERVED_SECTORS - ROOT_DIRECTORY_SECTORS - FAT_COUNT * fatSectors;

  return {
    imageSizeBytes,
    totalImageSectors,
    partitionOffset,
    partitionSectors,
    sectorsPerCluster,
    fatSectors,
    clusterCount,
    fat1Offset,
    fat2Offset,
    rootDirectoryOffset,
    dataOffset,
    dataSectors
  };
}

function chooseSectorsPerCluster(partitionSectors) {
  if (partitionSectors <= 16384) {
    return 2;
  }

  if (partitionSectors <= 131072) {
    return 4;
  }

  if (partitionSectors <= 262144) {
    return 8;
  }

  return 16;
}

function writeMbr(imageBuffer, layout) {
  const partitionEntryOffset = 446;
  const startChs = encodeChs(PARTITION_START_SECTOR);
  const endChs = encodeChs(PARTITION_START_SECTOR + layout.partitionSectors - 1);

  imageBuffer[partitionEntryOffset] = 0x80;
  startChs.copy(imageBuffer, partitionEntryOffset + 1);
  imageBuffer[partitionEntryOffset + 4] = layout.partitionSectors > 65535 ? 0x06 : 0x04;
  endChs.copy(imageBuffer, partitionEntryOffset + 5);
  imageBuffer.writeUInt32LE(PARTITION_START_SECTOR, partitionEntryOffset + 8);
  imageBuffer.writeUInt32LE(layout.partitionSectors, partitionEntryOffset + 12);
  imageBuffer[510] = 0x55;
  imageBuffer[511] = 0xaa;
}

function writeBootSector(imageBuffer, layout, volumeLabel) {
  const partitionView = imageBuffer.subarray(layout.partitionOffset, layout.partitionOffset + BYTES_PER_SECTOR);
  const normalizedLabel = normalizeVolumeLabel(volumeLabel);
  const serial = createVolumeSerial(normalizedLabel);

  partitionView[0] = 0xeb;
  partitionView[1] = 0x3c;
  partitionView[2] = 0x90;
  partitionView.write("MSDOS5.0", 3, "ascii");
  partitionView.writeUInt16LE(BYTES_PER_SECTOR, 11);
  partitionView[13] = layout.sectorsPerCluster;
  partitionView.writeUInt16LE(RESERVED_SECTORS, 14);
  partitionView[16] = FAT_COUNT;
  partitionView.writeUInt16LE(ROOT_DIRECTORY_ENTRIES, 17);
  partitionView.writeUInt16LE(layout.partitionSectors <= 65535 ? layout.partitionSectors : 0, 19);
  partitionView[21] = 0xf8;
  partitionView.writeUInt16LE(layout.fatSectors, 22);
  partitionView.writeUInt16LE(SECTORS_PER_TRACK, 24);
  partitionView.writeUInt16LE(HEAD_COUNT, 26);
  partitionView.writeUInt32LE(PARTITION_START_SECTOR, 28);
  partitionView.writeUInt32LE(layout.partitionSectors > 65535 ? layout.partitionSectors : 0, 32);
  partitionView[36] = 0x80;
  partitionView[37] = 0;
  partitionView[38] = 0x29;
  partitionView.writeUInt32LE(serial, 39);
  partitionView.write(normalizedLabel, 43, "ascii");
  partitionView.write("FAT16   ", 54, "ascii");
  partitionView[510] = 0x55;
  partitionView[511] = 0xaa;
}

function writeFileSystemPayload(imageBuffer, layout, files, volumeLabel) {
  const fatEntries = new Uint16Array(layout.clusterCount + 2);
  const clusterSizeBytes = layout.sectorsPerCluster * BYTES_PER_SECTOR;
  let nextCluster = 2;
  let rootOffset = layout.rootDirectoryOffset;

  fatEntries[0] = 0xfff8;
  fatEntries[1] = 0xffff;

  // 步骤 1：先写入卷标根目录项，确保 DOS 打开磁盘时能显示正确卷名。
  writeVolumeLabelEntry(imageBuffer, rootOffset, volumeLabel);
  rootOffset += 32;

  const fileAllocations = [];

  // 步骤 2：按顺序为每个文件分配簇、写数据，并同步建立根目录条目。
  for (const fileEntry of files) {
    const dosName = normalizeDosFileName(fileEntry.dosName);
    const clusterCount = fileEntry.size === 0 ? 0 : Math.ceil(fileEntry.size / clusterSizeBytes);
    const startCluster = clusterCount > 0 ? nextCluster : 0;

    if (nextCluster + clusterCount - 2 > layout.clusterCount) {
      throw new Error(`FAT16 镜像空间不足，无法写入 ${fileEntry.dosName}。`);
    }

    for (let index = 0; index < clusterCount; index += 1) {
      const currentCluster = nextCluster + index;
      const nextValue = index === clusterCount - 1 ? 0xffff : currentCluster + 1;
      fatEntries[currentCluster] = nextValue;
    }

    if (clusterCount > 0) {
      const dataOffset = layout.dataOffset + (startCluster - 2) * clusterSizeBytes;
      fileEntry.buffer.copy(imageBuffer, dataOffset);
    }

    writeRootFileEntry(imageBuffer, rootOffset, dosName, fileEntry.size, startCluster, fileEntry.mtimeMs);
    rootOffset += 32;
    nextCluster += clusterCount;

    fileAllocations.push({ dosName: dosName.displayName, size: fileEntry.size, startCluster, clusters: clusterCount });
  }

  writeFatTable(imageBuffer, layout.fat1Offset, fatEntries);
  writeFatTable(imageBuffer, layout.fat2Offset, fatEntries);

  return { files: fileAllocations };
}

function writeFatTable(imageBuffer, fatOffset, fatEntries) {
  for (let index = 0; index < fatEntries.length; index += 1) {
    imageBuffer.writeUInt16LE(fatEntries[index], fatOffset + index * 2);
  }
}

function writeVolumeLabelEntry(imageBuffer, offset, volumeLabel) {
  imageBuffer.write(normalizeVolumeLabel(volumeLabel), offset, "ascii");
  imageBuffer[offset + 11] = 0x08;
}

function writeRootFileEntry(imageBuffer, offset, dosName, size, startCluster, mtimeMs) {
  const { namePart, extensionPart } = dosName;
  const { date, time } = convertToDosTimestamp(mtimeMs);

  imageBuffer.write(namePart, offset, "ascii");
  imageBuffer.write(extensionPart, offset + 8, "ascii");
  imageBuffer[offset + 11] = 0x20;
  imageBuffer.writeUInt16LE(time, offset + 22);
  imageBuffer.writeUInt16LE(date, offset + 24);
  imageBuffer.writeUInt16LE(startCluster, offset + 26);
  imageBuffer.writeUInt32LE(size, offset + 28);
}

function convertToDosTimestamp(mtimeMs) {
  const date = new Date(mtimeMs);
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (hours << 11) | (minutes << 5) | seconds
  };
}

function normalizeDosFileName(fileName) {
  const upperCaseName = fileName.toUpperCase();
  const nameParts = upperCaseName.split(".");

  if (nameParts.length > 2) {
    throw new Error(`当前只支持标准 8.3 文件名，不支持多重扩展名: ${fileName}`);
  }

  const baseName = nameParts[0] || "";
  const extensionName = nameParts[1] || "";

  if (!baseName || baseName.length > 8 || extensionName.length > 3) {
    throw new Error(`文件名不符合 DOS 8.3 规则: ${fileName}`);
  }

  if (!DOS_ALLOWED_CHARS.test(baseName) || (extensionName && !DOS_ALLOWED_CHARS.test(extensionName))) {
    throw new Error(`文件名包含 DOS 8.3 不支持的字符: ${fileName}`);
  }

  return {
    displayName: extensionName ? `${baseName}.${extensionName}` : baseName,
    namePart: baseName.padEnd(8, " "),
    extensionPart: extensionName.padEnd(3, " ")
  };
}

function normalizeVolumeLabel(volumeLabel) {
  const sanitized = volumeLabel.toUpperCase().replace(/[^A-Z0-9 ]/g, "").slice(0, 11);
  return sanitized.padEnd(11, " ");
}

function createVolumeSerial(volumeLabel) {
  const hash = createHash("md5").update(volumeLabel).digest();
  return hash.readUInt32LE(0);
}

function encodeChs(lbaSector) {
  const sectorsPerCylinder = HEAD_COUNT * SECTORS_PER_TRACK;
  const cylinder = Math.min(Math.floor(lbaSector / sectorsPerCylinder), 1023);
  const head = Math.min(Math.floor((lbaSector % sectorsPerCylinder) / SECTORS_PER_TRACK), 255);
  const sector = (lbaSector % SECTORS_PER_TRACK) + 1;
  const chs = Buffer.alloc(3);

  chs[0] = head;
  chs[1] = (sector & 0x3f) | ((cylinder >> 2) & 0xc0);
  chs[2] = cylinder & 0xff;

  return chs;
}

function roundUpToMiB(size) {
  const mib = 1024 * 1024;
  return Math.ceil(size / mib) * mib;
}

function alignToSector(size) {
  return Math.ceil(size / BYTES_PER_SECTOR) * BYTES_PER_SECTOR;
}
