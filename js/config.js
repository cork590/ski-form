// 公開版と試験版（ski-form-beta）の切り替え。同じドメインなので保存先を分ける
export const IS_BETA = location.pathname.includes('ski-form-beta');
export const DB_NAME = IS_BETA ? 'ski-form-beta' : 'ski-form';
export const VERSION = '0.10.11';
