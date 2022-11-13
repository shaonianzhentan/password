import { useState, useEffect } from 'react';
import ha from '../homeassistant';

export default function Add() {

    const [data, setData] = useState({
        title: '',
        category: '',
        text: ''
    })
    const handleChange = e => {
        const { value, name } = e.target
        setData(preData => {
            return {
                ...preData,
                [name]: value
            }
        })
    }

    // 保存
    const saveClick = async (event) => {
        if (data.text && data.category && data.title) {
            await ha.put(data)
        } else {
            top.alert("全部都要填写")
            event.preventDefault();
        }
    }

    return (
        <div className="navbar-end">
            <label htmlFor="my-modal-2" className="btn btn-ghost normal-case text-xl">+ 新增</label>
            <input type="checkbox" id="my-modal-2" className="modal-toggle" />
            <div className="modal">
                <div className="modal-box relative">
                    <label htmlFor="my-modal-2" className="btn btn-sm btn-circle absolute right-2 top-2">✕</label>

                    <h3 className="font-bold text-lg">我的密码</h3>
                    <p className="py-4"></p>

                    <div className="form-control">
                        <label className="label">
                            <span className="label-text">分类</span>
                        </label>
                        <input type="search"
                            name="category" value={data.category} onChange={handleChange}
                            list="category" placeholder="请选择..." className="input input-bordered w-full" />
                        <datalist id="category">
                            <option>网站</option>
                            <option>银行</option>
                            <option>APP</option>
                            <option>邮箱</option>
                            <option>影音</option>
                            <option>社交</option>
                            <option>其它</option>
                        </datalist>
                    </div>

                    <div className="form-control">
                        <label className="label">
                            <span className="label-text">备注信息</span>
                        </label>
                        <input type="text" name="title" value={data.title} onChange={handleChange} placeholder="请输入..." className="input input-bordered w-full" />
                    </div>

                    <div className="form-control">
                        <label className="label">
                            <span className="label-text">加密内容</span>
                        </label>
                        <textarea name="text" value={data.text} onChange={handleChange}
                            placeholder="账号：&#10;密码：" rows={4} className="textarea textarea-bordered w-full" />
                    </div>

                    <div className="modal-action">
                        <a href="#" className="btn" onClick={saveClick}>保存信息</a>
                    </div>
                </div>
            </div>
        </div>
    )
}