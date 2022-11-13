import { useState, useEffect } from 'react';

export default function ({ data }) {
    return (
        <div>
            <input type="checkbox" id="my-modal-3" className="modal-toggle" />
            <div className="modal">
                <div className="modal-box relative">
                    <label htmlFor="my-modal-3" className="btn btn-sm btn-circle absolute right-2 top-2">✕</label>
                    <h3 className="text-lg font-bold">{data.title}</h3>
                    <p className="py-4">{data.text}</p>
                </div>
            </div>
        </div>
    )
}