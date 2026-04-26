export interface Package {
    name: string;
    version: string;
}
export declare function fetchReleaseDate(packageName: string, version: string): Promise<Date>;
export declare function readPackageLock(lockfilePath: string): Package[];
export declare function readYarnLock(lockfilePath: string): Package[];
export declare function readPnpmLock(lockfilePath: string): Package[];
export declare function checkPackageAges(minAgeHours: number): Promise<void>;
