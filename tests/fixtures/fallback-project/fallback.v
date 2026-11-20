module fallback_top (
    input  wire engine_data,
    output wire fallback_out
);
    assign fallback_out = engine_data;
endmodule
